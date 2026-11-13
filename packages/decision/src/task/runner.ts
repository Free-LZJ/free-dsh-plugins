/**
 * 执行器：事件 → 一个任务 → 一条节点链。
 *
 * 这里是「分级漏斗」的落地，每一级内部都是首命中：
 *
 * ```
 * L0  emit      触发器按 priority 追问，第一个接手的定任务（不扇出）
 * L1  classify  可选；一次模型调用（标签集为空就整个跳过）
 * L2  rule      按 priority 首命中；`stopOnMatch: false` 时后续命中追加动作
 * L3  action    then 顺序执行，五分支由这里处理（关掉/试运行/建议/延迟/执行）
 * ```
 *
 * 三条硬约束：
 *
 * 1. **一个事件至多一个任务**。所以 `emit` 一旦有人接手就 `return`，不会继续问后面的
 *    触发器；同一件事重复到达由 `dedupeKey` 挡住。
 * 2. **一个任务只有一条链**。同一 `key` 的后续事件**追加**节点，不新建任务——看板上
 *    因此永远只有一张卡。
 * 3. **核心不认识任何领域**。规则、条件、动作、端口全部从连接器来；这里只有「顺序」
 *    「记账」「重试」「撤销」。
 *
 * @module @free-lzj/dsh-decision/task/runner
 */

import { randomUUID } from 'node:crypto'
import type { DecisionConfigBase } from '../config.ts'
import { ruleMatches } from '../match.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import type { Rule } from '../types.ts'
import type { TaskConnector } from './connector.ts'
import type { TaskContext } from './context.ts'
import type { DeferredRecord, DeferredStore } from './deferred.ts'
import type { EmitAck, TaskEvent, TaskTrigger, TriggerOutcome } from './event.ts'
import type { ActionNode, NodeOutcome } from './node.ts'
import type { ClassifyOutcome } from './connector.ts'
import type { NodePatch, Task, TaskNodeRecord, TaskStatus } from './record.ts'
import type { OwnedRegistry, TriggerRegistry } from './registry.ts'
import type { TaskStore } from './store.ts'

/** 一次任务的运行环境。 */
export interface RunnerDeps {
  readonly store: TaskStore
  readonly deferred: DeferredStore
  readonly triggers: TriggerRegistry
  readonly actions: OwnedRegistry<ActionNode<ActionSpecLike, TaskContext>>
  readonly connectors: ReadonlyMap<string, TaskConnector>
  /** 当前生效的规则（已按 priority 排序、已补 connector）。 */
  readonly rules: () => readonly Rule<ConditionSpecLike, ActionSpecLike>[]
  readonly config: () => DecisionConfigBase
  readonly log: (line: string) => void
  readonly warn: (line: string) => void
  readonly now: () => Date
  /** 结构变了：推进版本并推给订阅者。 */
  readonly changed: () => void
  /** 已登记的撤销闭包，按任务 id 归堆。 */
  readonly undos: Map<string, (() => Promise<void>)[]>
}

/** 一次撤销的结果。 */
export interface UndoResult {
  readonly ok: boolean
  readonly message: string
}

/** 执行器。 */
export class TaskRunner {
  /** 同一 `dedupeKey` 正在扇出时，第二次 emit 等它，别建两个任务。 */
  private readonly inFlight = new Map<string, Promise<EmitAck>>()
  /** 在后台跑的链；`flush` 用。 */
  private readonly running = new Set<Promise<void>>()

  /** @param deps - 存储、注册表、规则与配置。 */
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * 发布一个事实：选出接手的触发器、建或取任务、在后台跑链。
   * @param event - 连接器发的事件。
   * @returns 谁接的、产出了哪个任务、谁没接。
   */
  async emit(event: TaskEvent): Promise<EmitAck> {
    const key = event.dedupeKey
    if (key !== undefined) {
      const running = this.inFlight.get(key)
      if (running !== undefined) return await running
      const existing = this.deps.store.byEventKey(key)
      if (existing !== undefined) {
        return {
          handled: true,
          taskId: existing.id,
          triggerId: existing.triggerId,
          duplicate: true,
          skipped: [{ triggerId: existing.triggerId, reason: 'duplicate' }],
        }
      }
    }
    const work = this.fanout(event)
    if (key === undefined) return await work
    this.inFlight.set(key, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** 追问触发器，首个接手即停。 */
  private async fanout(event: TaskEvent): Promise<EmitAck> {
    const skipped: { triggerId: string; reason: string }[] = []
    const candidates = this.deps.triggers.candidates(event.type)
    if (candidates.length === 0) return { handled: false, skipped }
    for (const trigger of candidates) {
      const connector = this.deps.connectors.get(trigger.connector)
      if (connector === undefined) {
        skipped.push({ triggerId: trigger.id, reason: 'no-connector' })
        continue
      }
      if (trigger.match !== undefined && !trigger.match(event)) {
        skipped.push({ triggerId: trigger.id, reason: 'no-match' })
        continue
      }
      const outcome = await this.runTrigger(trigger, event)
      if (outcome.seed === undefined) {
        skipped.push({ triggerId: trigger.id, reason: outcome.ok ? 'declined' : 'error' })
        continue
      }
      const task = await this.ensureTask(trigger, event, outcome)
      const at = this.deps.now().toISOString()
      await this.deps.store.appendNode(task.id, {
        id: `node-${randomUUID()}`,
        kind: 'trigger',
        at,
        ok: true,
        detail: outcome.detail,
        data: { triggerId: trigger.id, eventType: event.type, source: event.source, ...(outcome.data ?? {}) },
      })
      // 触发器自己已经建好/指向了一个会话（`open_session` 工具就是这样）：链上补一格，
      // 让"工具发起的活"与"规则派出的活"在看板上一模一样。
      if (outcome.sessionId !== undefined) {
        await this.deps.store.appendNode(task.id, {
          id: `node-${randomUUID()}`,
          kind: 'session',
          at,
          ok: true,
          detail: `会话 ${outcome.sessionId.slice(0, 8)}`,
          sessionId: outcome.sessionId,
          data: { scope: 'workspace', mode: 'followup', external: true },
        })
      }
      this.track(this.runChain(task.id))
      this.deps.changed()
      return { handled: true, taskId: task.id, triggerId: trigger.id, skipped }
    }
    return { handled: false, skipped }
  }

  /** 跑一个触发器；它不该抛，抛了也折成失败。 */
  private async runTrigger(trigger: TaskTrigger, event: TaskEvent): Promise<TriggerOutcome> {
    try {
      return await trigger.run(event, {
        event,
        ports: this.allPorts(),
        now: this.deps.now(),
        log: line => this.deps.warn(line),
      })
    } catch (error: unknown) {
      this.deps.warn(`触发器 ${trigger.id} 抛错：${describe(error)}`)
      return { status: 'halt', ok: false, detail: `触发器出错：${describe(error)}`, failure: 'config' }
    }
  }

  /** 建一个任务，或取同一 `key` 的既有任务（后续事件追加到同一条链）。 */
  private async ensureTask(trigger: TaskTrigger, event: TaskEvent, outcome: TriggerOutcome): Promise<Task> {
    const seed = outcome.seed as NonNullable<TriggerOutcome['seed']>
    const existing = this.deps.store.byKey(seed.key)
    if (existing !== undefined) return existing
    const at = this.deps.now().toISOString()
    return await this.deps.store.create({
      id: `task-${randomUUID()}`,
      connector: trigger.connector,
      triggerId: trigger.id,
      key: seed.key,
      ...(event.dedupeKey === undefined ? {} : { eventKey: event.dedupeKey }),
      title: seed.title,
      at,
      updatedAt: at,
      status: 'running',
      nodes: [],
      event,
      vars: seed.vars ?? {},
    })
  }

  /**
   * 跑完一个任务的链。
   *
   * 公共方法：延迟动作到期、建议被批准、重启后恢复都会重入这里。
   * @param taskId - 任务 id。
   */
  async runChain(taskId: string): Promise<void> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return
    const connector = this.deps.connectors.get(task.connector)
    if (connector === undefined) {
      await this.finish(taskId, 'failed', `触发它的连接器「${task.connector}」已经不在了`)
      return
    }
    const config = this.deps.config()
    if (!config.enabled) {
      await this.appendNode(task, 'rule', false, '分诊已关闭（enabled: false）')
      await this.finish(taskId, 'skipped', '分诊已关闭')
      return
    }

    const ports = this.allPorts()
    const usable = this.deps.rules().filter(rule => rule.enabled)
    // 两段：**本域的规则先跑**，一条都没命中才轮到 `connector: '*'` 的全局规则。
    // 兜底的意义是"谁都没管这件事时提醒我"，所以它必须排在专属规则之后，
    // 而不是靠 priority 数字去和它们抢。
    const own = usable.filter(rule => rule.connector === connector.id)
    const global = usable.filter(rule => rule.connector === '*')

    // L1 分类：只问一次；标签集为空就整个跳过，一次模型调用都不花。
    const classification = await this.runClassify(task, connector, [...own, ...global], ports)

    // L2 规则：首命中；`stopOnMatch: false` 时继续找，命中的 then 依次追加。
    const matched: Rule<ConditionSpecLike, ActionSpecLike>[] = []
    for (const rule of own) {
      if (!(await this.ruleHolds(rule, task, connector, ports, classification))) continue
      matched.push(rule)
      if (rule.stopOnMatch !== false) break
    }
    if (matched.length === 0) {
      for (const rule of global) {
        if (!(await this.ruleHolds(rule, task, connector, ports, classification))) continue
        matched.push(rule)
        if (rule.stopOnMatch !== false) break
      }
    }
    if (matched.length === 0) {
      await this.appendNode(task, 'rule', true, '没有规则命中', { data: { ruleId: '(none)' } })
      await this.finish(taskId, 'skipped', '没有规则命中')
      return
    }
    for (const rule of matched) {
      await this.appendNode(task, 'rule', true, rule.label ?? rule.name, {
        data: { ruleId: rule.id, ruleName: rule.name, label: rule.label ?? rule.name },
      })
    }

    // L3 动作：按命中顺序，各自 then 顺序执行。
    let failed = false
    for (const rule of matched) {
      for (const [index, spec] of rule.then.entries()) {
        const outcome = await this.runAction(task.id, connector, spec, index, ports)
        if (!outcome) failed = true
      }
    }
    await this.settle(taskId, failed)
  }

  /** L1：需要才跑，跑完把 label 交回去。 */
  private async runClassify(
    task: Task,
    connector: TaskConnector,
    rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[],
    ports: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly label: string; readonly confidence: number }> {
    const plan = connector.classify?.plan(rules)
    const node = connector.classify?.node
    if (plan === undefined || node === undefined) return { label: 'uncertain', confidence: 0 }
    const nodeId = `node-${randomUUID()}`
    let outcome: ClassifyOutcome
    try {
      outcome = await node.run(plan, this.contextOf(task, ports, nodeId, 'classify'))
    } catch (error: unknown) {
      outcome = { status: 'continue', ok: false, detail: `分类失败：${describe(error)}`, failure: 'transient' }
    }
    await this.deps.store.appendNode(task.id, {
      id: nodeId,
      kind: 'classify',
      at: this.deps.now().toISOString(),
      ok: outcome.ok,
      detail: outcome.detail,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      data: {
        labels: plan.labels,
        ...(outcome.label === undefined ? {} : { label: outcome.label }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        ...(outcome.model === undefined ? {} : { model: outcome.model }),
        ...(outcome.answer === undefined ? {} : { answer: outcome.answer }),
      },
    })
    this.deps.changed()
    return { label: outcome.label ?? 'uncertain', confidence: outcome.confidence ?? 0 }
  }

  /** L2：一条规则的条件是否全部成立。没有条件词表的连接器只认空 `when`。 */
  private async ruleHolds(
    rule: Rule<ConditionSpecLike, ActionSpecLike>,
    task: Task,
    connector: TaskConnector,
    ports: Readonly<Record<string, unknown>>,
    classification: { readonly label: string; readonly confidence: number },
  ): Promise<boolean> {
    const judge = connector.judge
    if (judge === undefined) return rule.when.length === 0
    const runtime = judge.plan({
      task,
      event: task.event,
      ports,
      classification: async () => classification,
    })
    return await ruleMatches(
      { name: rule.name, when: rule.when },
      {
        conditions: { get: kind => judge.conditions.get(kind) },
        context: state => runtime.context(state),
        readBody: runtime.readBody,
        log: line => this.deps.warn(line),
      },
    )
  }

  /**
   * L3：一个动作，五分支。
   * @returns `false` 表示这个动作失败了（任务记 partial）。
   */
  private async runAction(
    taskId: string,
    connector: TaskConnector,
    spec: ActionSpecLike,
    actionIndex: number,
    ports: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return true
    const config = this.deps.config()
    const nodeId = `node-${randomUUID()}`
    const at = this.deps.now().toISOString()
    const write = async (ok: boolean, detail: string, extra: Partial<TaskNodeRecord> = {}): Promise<void> => {
      await this.deps.store.appendNode(taskId, {
        id: nodeId,
        kind: spec.kind,
        at,
        ok,
        detail,
        actionIndex,
        ...(extra.failure === undefined ? {} : { failure: extra.failure }),
        ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
        data: { ...(extra.data ?? {}) },
      })
      this.deps.changed()
    }

    if (config.dryRun) {
      await write(true, '试运行：只记录，未执行')
      return true
    }

    const action = this.deps.actions.get(spec.kind)
    if (action === undefined) {
      await write(false, `本部署没有实现动作 ${spec.kind}`, { failure: 'config' })
      return false
    }

    const delay = spec.delaySeconds ?? (action.sideEffect === true ? config.undoWindowSeconds : 0)
    if (delay > 0) {
      const dueAt = new Date(this.deps.now().getTime() + delay * 1000).toISOString()
      await this.deps.deferred.add({ taskId, nodeId, connector: connector.id, kind: 'delay', spec, dueAt })
      await write(true, `已排队，${String(delay)} 秒后执行（此前可撤销）`)
      await this.deps.store.patch(taskId, { undoableUntil: dueAt })
      return true
    }

    const outcome = await action.run(spec, this.contextOf(task, ports, nodeId, spec.kind))
    if (outcome.undo !== undefined) this.registerUndo(taskId, outcome.undo)
    await write(outcome.ok, outcome.detail, {
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    })
    if (outcome.sessionId !== undefined) {
      // 会话是链上的一格：它有自己的 id、状态、可点开，而不是动作身上一个字段。
      await this.deps.store.appendNode(taskId, {
        id: `node-${randomUUID()}`,
        kind: 'session',
        at,
        ok: outcome.ok,
        detail: `会话 ${outcome.sessionId.slice(0, 8)}`,
        sessionId: outcome.sessionId,
        data: { ...(outcome.data ?? {}) },
      })
      this.deps.changed()
    }
    return outcome.ok
  }

  /** 汇总状态：全成 done，有失败 partial；有副作用且结束 → 待确认。 */
  private async settle(taskId: string, failed: boolean): Promise<void> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return
    const status: TaskStatus = failed ? 'partial' : 'done'
    const hasSideEffect = task.nodes.some(node => node.kind !== 'trigger' && node.kind !== 'classify' && node.kind !== 'rule')
    await this.deps.store.patch(taskId, {
      status,
      ...(status === 'done' && hasSideEffect ? { awaitingConfirmation: true } : {}),
    })
    this.deps.changed()
  }

  /** 追加一格并把任务标成终态；给「没有规则」「连接器没了」这些早退路径用。 */
  private async finish(taskId: string, status: TaskStatus, detail: string): Promise<void> {
    await this.deps.store.patch(taskId, { status })
    this.deps.changed()
    if (detail !== '') this.deps.log(`任务 ${taskId}：${detail}`)
  }

  /** 追加一格普通节点（规则/说明）。 */
  private async appendNode(
    task: Task,
    kind: string,
    ok: boolean,
    detail: string,
    extra: { readonly data?: Readonly<Record<string, unknown>> } = {},
  ): Promise<void> {
    await this.deps.store.appendNode(task.id, {
      id: `node-${randomUUID()}`,
      kind,
      at: this.deps.now().toISOString(),
      ok,
      detail,
      ...(extra.data === undefined ? {} : { data: extra.data }),
    })
    this.deps.changed()
  }

  /**
   * 执行到期的延迟动作。
   * @param now - 现在；测试可以钉死。
   * @returns 执行了几条。
   */
  async runDue(now: Date = this.deps.now()): Promise<number> {
    const due = await this.deps.deferred.takeDue(now)
    for (const record of due) await this.executeDeferred(record)
    return due.length
  }

  /**
   * 执行一条已排队的动作（到期，或建议被批准）。
   * @param deferredId - 队列记录 id。
   * @returns 结果，或为什么不能执行。
   */
  async applyDeferred(deferredId: string): Promise<UndoResult> {
    const record = this.deps.deferred.list().find(item => item.id === deferredId)
    if (record === undefined) return { ok: false, message: '这条排队项已经不在了' }
    await this.deps.deferred.remove(record.id)
    return await this.executeDeferred(record)
  }

  /** 真正执行一条排队项，并把结果就地回填到它的节点上。 */
  private async executeDeferred(record: DeferredRecord): Promise<UndoResult> {
    const task = this.deps.store.get(record.taskId)
    const action = this.deps.actions.get(record.spec.kind)
    if (task === undefined) return { ok: false, message: `任务 ${record.taskId} 已经不在了` }
    if (action === undefined) {
      await this.patchNode(record.taskId, record.nodeId, {
        ok: false,
        detail: `本部署没有实现动作 ${record.spec.kind}`,
        failure: 'config',
      })
      return { ok: false, message: `本部署没有实现动作 ${record.spec.kind}` }
    }
    const outcome = await action.run(record.spec, this.contextOf(task, this.allPorts(), record.nodeId, record.spec.kind))
    if (outcome.undo !== undefined) this.registerUndo(record.taskId, outcome.undo)
    await this.patchNode(record.taskId, record.nodeId, {
      ok: outcome.ok,
      detail: outcome.detail,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    })
    if (!outcome.ok) await this.deps.store.patch(record.taskId, { status: 'partial' })
    this.deps.changed()
    return { ok: outcome.ok, message: outcome.detail }
  }

  /** 就地改一格。 */
  private async patchNode(taskId: string, nodeId: string, patch: NodePatch): Promise<void> {
    await this.deps.store.patchNode(taskId, nodeId, patch)
  }

  /**
   * 撤销一个任务：窗口内取消、窗口外回滚（逆序）。
   * @param taskId - 任务 id。
   * @returns 结果与一句说明。
   */
  async undo(taskId: string): Promise<UndoResult> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return { ok: false, message: `没有这个任务：${taskId}` }
    if (task.status === 'undone') return { ok: false, message: '这个任务已经撤销过了' }
    const cancelled = await this.deps.deferred.cancelByTask(taskId)
    const undos = this.deps.undos.get(taskId) ?? []
    let reversed = 0
    for (const undo of [...undos].reverse()) {
      try {
        await undo()
        reversed += 1
      } catch (error: unknown) {
        this.deps.warn(`撤销 ${taskId} 时出错：${describe(error)}`)
      }
    }
    if (cancelled === 0 && reversed === 0) {
      return { ok: false, message: '这个任务里的动作都撤不回来（例如已经建出的会话）' }
    }
    await this.deps.store.patch(taskId, { status: 'undone' })
    this.deps.changed()
    const parts: string[] = []
    if (cancelled > 0) parts.push(`取消 ${String(cancelled)} 个未执行的动作`)
    if (reversed > 0) parts.push(`回滚 ${String(reversed)} 个已执行的动作`)
    return { ok: true, message: parts.join('，') }
  }

  /** 登记一个回滚闭包。 */
  registerUndo(taskId: string, undo: () => Promise<void>): void {
    const existing = this.deps.undos.get(taskId) ?? []
    this.deps.undos.set(taskId, [...existing, undo])
  }

  /** 所有在跑的链都结束；测试用，生产不需要。 */
  async flush(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running])
    }
  }

  /** 各连接器的端口合并成一个袋子；动作按需取自己那份。 */
  private allPorts(): Readonly<Record<string, unknown>> {
    const merged: Record<string, unknown> = {}
    for (const connector of this.deps.connectors.values()) {
      if (connector.ports !== undefined) Object.assign(merged, connector.ports)
    }
    return merged
  }

  /** 造一个节点上下文。 */
  private contextOf(
    task: Task,
    ports: Readonly<Record<string, unknown>>,
    nodeId: string,
    kind: string,
  ): TaskContext {
    return {
      task,
      event: task.event,
      vars: this.varsOf(task),
      node: { id: nodeId, kind },
      ports,
      now: this.deps.now(),
      log: line => this.deps.warn(line),
    }
  }

  /**
   * 模板变量：**通用三项**在前，事件自己的变量在后。
   *
   * `title` / `source` / `event` 任何事件都有，所以一条全局兜底规则的文案不必知道
   * 触发它的是邮件还是别的什么——它只说「{source} · {title}」。连接器提供的变量
   * （邮件的 `{from}`、`{subject}`…）覆盖同名的通用项，因为它们更具体。
   * @param task - 任务。
   * @returns 可填充的变量表。
   */
  private varsOf(task: Task): Record<string, string> {
    const label = this.deps.connectors.get(task.connector)?.label ?? task.connector
    return {
      title: task.title,
      source: label,
      event: task.event.type,
      ...task.vars,
    }
  }

  /** 把一个后台链记进 running，好让 `flush` 等它。 */
  private track(work: Promise<void>): void {
    const guarded = work.catch((error: unknown) => {
      this.deps.warn(`任务链失败：${describe(error)}`)
    })
    this.running.add(guarded)
    void guarded.finally(() => { this.running.delete(guarded) })
  }
}

/** 一个抛出物作为一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { NodeOutcome }
