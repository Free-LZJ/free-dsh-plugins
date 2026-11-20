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
import { executeFlow } from '../flow/execute.ts'
import type { DecisionConfigBase } from '../config.ts'
import { ruleMatches } from '../match.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import type { Rule } from '../types.ts'
import type { Flow, FlowContext, FlowNodeSpec, SuspendSpec } from '../flow/types.ts'
import type { FlowNodeRegistry } from '../flow/registry.ts'
import type { TaskConnector } from './connector.ts'
import type { TaskContext } from './context.ts'
import type { DeferredRecord, DeferredStore } from './deferred.ts'
import type { EmitAck, TaskEvent, TaskTrigger, TriggerOutcome } from './event.ts'
import type { ActionNode, NodeOutcome } from './node.ts'

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
  /** 当前生效的节点图；v1 规则文件时为空数组。 */
  readonly flows: () => readonly Flow[]
  /** 按触发器取事件流；没有就是 undefined。 */
  readonly eventFlowOf?: (triggerId: string) => Flow | undefined
  /** 按 id 取子工作流。 */
  readonly workflowOf?: (id: string) => Flow | undefined
  readonly nodes: FlowNodeRegistry
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

/** 一次动作执行的结果；`wait` 表示派发成功但还没做完。 */
export interface ActionRun {
  readonly ok: boolean
  readonly detail: string
  readonly sessionId?: string
  readonly wait?: SuspendSpec
}

/** 唤醒一条挂起的任务。 */
export interface ResumeInput {
  /** 按任务唤醒；与 `token` 二选一。 */
  readonly taskId?: string
  /** 按唤醒令牌找人；不知道任务 id 的调用方用它（例如等待的探针）。 */
  readonly token?: string
  /** 唤醒载荷：合进挂起时留的 `resume`，一起交给节点。 */
  readonly payload?: Readonly<Record<string, unknown>>
  /** 谁唤醒的（`probe` / `human` / 工具名），只用于记录。 */
  readonly actor?: string
}

/** 执行器。 */
export class TaskRunner {
  /** 同一 `dedupeKey` 正在扇出时，第二次 emit 等它，别建两个任务。 */
  private readonly inFlight = new Map<string, Promise<EmitAck>>()
  /** 在后台跑的链；`flush` 用。 */
  private readonly running = new Set<Promise<void>>()

  /** @param deps - 存储、注册表、规则与配置。 */
  /**
   * 分类结果缓存：同一任务、同一个问法只问一次模型。
   *
   * 键里必须带上标签集与提示词。一张 `switch` 上的每条 `classifier` 出边问的是
   * **不同的问题**（`labels` 不同，模型给的答案也就不同），只按 `task.id` 缓存会让
   * 第一条边的问题套住后面每一条：命中的答案不在后几条边的标签集里，整张图就恒落到
   * 兜底那条边——这正是「GitHub 通知被判成兜底」的成因。
   */
  private readonly classifications = new Map<string, Promise<{ readonly label: string; readonly confidence: number }>>()

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
  async runChain(taskId: string, signal?: Readonly<Record<string, unknown>>): Promise<void> {
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
    // 先看有没有节点图：有就走图，没有走旧的规则列表。二者互斥，不是两套同时生效。
      const graph = this.pickFlow(connector.id, task.triggerId)
    if (graph !== undefined) {
      await this.runFlow(task, connector, graph, ports, config, signal)
      return
    }

    // 规则文件里没有能用的流程图。
    // **这不是失败，是「没配」**：内置连接器发的某些事件本来就可能没人接——`open_session`
    // 建完会话后发的 `console.tool.invoked` 就是这种。把「没配图」记成 failed，等于每开一次
    // 会话就往看板上挂一条红点，红色随即失去意义：真错和没配置混在一起，人就不再看它了。
    // 所以记一格「跳过」、任务标成 skipped：红色只留给真的执行出错。
    const detail = `没有接「${task.triggerId}」的事件流，这条事件跳过`
    await this.appendNode(task, 'rule', true, detail)
    await this.finish(taskId, 'skipped', detail)
  }

  /**
   * 挑一张适用于这个连接器的图。
   *
   * 专属图优先，没有才轮到 `connector: '*'` 的兜底图——与旧规则「本域先跑、全局兜底」
   * 同一顺序。
   * @param connectorId - 连接器 id。
   * @returns 图，或 undefined（这份规则文件里没有图）。
   */
  private pickFlow(connectorId: string, triggerId?: string): Flow | undefined {
    // 事件流优先：一个连接器可以有多个事件，按触发器分才不串。
    if (triggerId !== undefined) {
      const byTrigger = this.deps.eventFlowOf?.(triggerId)
      if (byTrigger !== undefined) return byTrigger
    }
    // 回退到旧的「按连接器找图」，迁移期还在用。
    const flows = this.deps.flows()
    return flows.find(flow => flow.connector === connectorId) ?? flows.find(flow => flow.connector === '*')
  }

  /**
   * 用节点图跑一个任务。
   *
   * 与旧路径的关键差别：**执行有边界**。同一任务的新事实开新的一轮（`runId` 变了），
   * 而不是把整条链从头重跑一遍；同一轮的续跑靠 `task.progress`，已完成的节点不再执行。
   * @param task - 任务。
   * @param connector - 它归属的连接器。
   * @param flow - 要跑的图。
   * @param ports - 连接器端口。
   * @param config - 判定配置。
   */
  /**
   * 问一次模型「这属于哪一类」，结果按任务缓存。
   *
   * 判定层要的就是「一封邮件只判一次」：`switch` 上可能挂着好几条 `classifier` 出边，
   * 每条都问一次既慢又可能给出不一致的答案。
   *
   * 条件里的 `labels` / `prompt` 直接交给连接器的分类节点——核心不认识标签的含义，
   * 那是连接器（邮件词表）的事。
   * @param connector - 连接器。
   * @param task - 任务。
   * @param when - 正在求值的那组条件（从里面取 `classifier` 的标签与提示词）。
   * @param ports - 连接器端口。
   * @returns 标签与置信度；没有分类能力时返回 `uncertain`。
   */
  private async classifyOnce(
    connector: TaskConnector,
    task: Task,
    when: readonly ConditionSpecLike[],
    ports: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly label: string; readonly confidence: number }> {
    /** 从条件里找第一个 `classifier`，它带着这一条边的标签集与提示词。 */
    const spec = when.find(condition => condition.kind === 'classifier') as
      | { readonly labels?: readonly string[]; readonly prompt?: string }
      | undefined
    if (spec === undefined) return { label: 'uncertain', confidence: 0 }

    const cacheKey = classificationKey(task.id, spec.labels, spec.prompt)
    const cached = this.classifications.get(cacheKey)
    if (cached !== undefined) return await cached

    const pending = (async () => {
      const classify = connector.classify
      if (classify === undefined) return { label: 'uncertain', confidence: 0 }

      try {
        const outcome = await classify.node.run(
          {
            kind: 'classify',
            ...(spec.labels === undefined ? {} : { labels: spec.labels }),
            ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
          } as never,
          {
            task,
            event: task.event,
            vars: task.vars,
            node: { id: 'classify', kind: 'classify' },
            ports,
            now: this.deps.now(),
            log: line => this.deps.log(line),
          },
        )
        const label = typeof outcome.label === 'string' ? outcome.label : 'uncertain'
        const confidence = typeof outcome.confidence === 'number' ? outcome.confidence : 0
        return { label, confidence }
      } catch (error: unknown) {
        this.deps.warn('分类失败：' + (error instanceof Error ? error.message : String(error)))
        return { label: 'uncertain', confidence: 0 }
      }
    })()

    this.classifications.set(cacheKey, pending)
    return await pending
  }

  /**
   * 丢掉某个任务的分类缓存。
   *
   * 一轮跑完就该丢：同一个任务不会重入同一轮，留着只是让长跑的工作台一路上涨。
   * 任务重新跑（延迟动作到期、建议被批准）时标签可能已经变了，旧答案也不该复用。
   * @param taskId - 任务 id。
   */
  private forgetClassifications(taskId: string): void {
    const prefix = `${taskId}\u0000`
    for (const key of this.classifications.keys()) {
      if (key.startsWith(prefix)) this.classifications.delete(key)
    }
  }

  private async runFlow(
    task: Task,
    connector: TaskConnector,
    flow: Flow,
    ports: Readonly<Record<string, unknown>>,
    config: DecisionConfigBase,
    signal?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const resuming = task.progress !== undefined && task.status === 'suspended'
    const runId = resuming ? (task.runId ?? `run-${randomUUID()}`) : `run-${randomUUID()}`
    const event = this.projectEvent(task)

    if (!resuming) {
      // 新的一轮：换 runId，清掉上一轮的进度。节点记录靠 runId 分组，历史不动。
      await this.deps.store.patch(task.id, { runId, status: 'running' })
    }

    /**
     * 正文只读一次。
     *
     * `judge.plan()` 每条出边求值都要重来（它依赖当次的 facts），但 `readBody` 背后是
     * 一次 IMAP 取信——一张 switch 五条出边就是五次连接。这里按「一次 runFlow」缓存住，
     * 谁先要谁付一次代价。
     */
    let bodyOnce: Promise<string> | undefined

    /**
     * 子工作流停在半路的那半张进度。
     *
     * 唤醒时父图会把 `pending.nested` 一起带回来，但 `runWorkflow` 闭包认不出「现在是
     * 不是当初那个节点在续跑」——所以这里只手递一次：第一个被调起来的子工作流拿走它，
     * 拿完就清掉，后面的调用（loop 里再调同一个工作流）不会误用别人的进度。
     */
    let nestedProgress = resuming ? task.progress?.pending?.nested : undefined

    const evaluate = async (
      when: readonly ConditionSpecLike[],
      context: { readonly facts: { label?: string; confidence?: number } },
    ): Promise<boolean> => {
      const judge = connector.judge
      if (judge === undefined) return false
      const runtime = judge.plan({
        task,
        event: task.event,
        ports,
        // 分类：图里跑过 classify 节点就用它的结果；没有就**现场问一次模型**并缓存。
        // 一张 switch 上有多条 classifier 出边时，这里保证只花一次调用。
        classification: async () => {
          if (context.facts.label !== undefined && context.facts.label !== '') {
            return { label: context.facts.label, confidence: context.facts.confidence ?? 0 }
          }
          return await this.classifyOnce(connector, task, when, ports)
        },
        facts: context.facts,
      })
      return await ruleMatches(
        { name: 'flow', when: when as never },
        {
          conditions: judge.conditions,
          context: runtime.context as never,
          readBody: () => (bodyOnce ??= runtime.readBody()),
          log: line => this.deps.warn(line),
        },
      )
    }

    const result = await executeFlow(
      flow,
      {
        taskId: task.id,
        runId,
        event,
        task,
        ports,
        evaluate: evaluate as never,
        // 旧式动作交给 runner 跑：于是撤销窗口、延迟排队、试运行在图上也照旧生效。
        executeAction: async (kind: string, spec: FlowNodeSpec, context: FlowContext) => {
          const index = context.vars['__actionIndex']
          const outcome = await this.runAction(
            task.id,
            connector,
            { kind, ...(spec.config ?? {}) } as ActionSpecLike,
            typeof index === 'number' ? index : 0,
            ports,
            context.signal,
          )
          // `wait` 必须原样上去：它是「派发成功但要等回信」，丢在这一层就变成假完成了。
          const sessionId = outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }
          return outcome.ok
            ? { ok: true, detail: outcome.detail, ...sessionId, ...(outcome.wait === undefined ? {} : { wait: outcome.wait }) }
            : { ok: false, detail: outcome.detail, failure: 'transient' as const, ...sessionId }
        },
        // 子工作流：从 `workflows/` 找图，用同一个执行器跑，进度独立。
        runWorkflow: async (workflowId, vars, outer) => {
          const sub = this.deps.workflowOf?.(workflowId)
          if (sub === undefined) {
            return { ok: false, detail: '没有工作流「' + workflowId + '」', failure: 'config' as const }
          }
          // 唤醒后第一次调子工作流：把它上次停在哪一格接过来。接完就清，别传给下一次。
          const carry = nestedProgress !== undefined && nestedProgress.flowId === workflowId ? nestedProgress : undefined
          nestedProgress = undefined
          const nested = await executeFlow(sub, {
            taskId: outer.taskId,
            runId: outer.runId,
            event: outer.event,
            vars: { ...vars },
            facts: outer.facts,
            ...(outer.task === undefined ? {} : { task: outer.task }),
            ...(outer.ports === undefined ? {} : { ports: outer.ports }),
            ...(outer.evaluate === undefined ? {} : { evaluate: outer.evaluate }),
            ...(outer.signal === undefined ? {} : { signal: outer.signal }),
            ...(outer.runWorkflow === undefined ? {} : { runWorkflow: outer.runWorkflow }),
            ...(carry === undefined ? {} : { progress: carry.progress }),
          }, {
            registry: this.deps.nodes,
            dryRun: config.dryRun,
            log: line => this.deps.log(line),
            record: async (entry) => {
              await this.deps.store.appendNode(task.id, {
                id: 'node-' + randomUUID(),
                kind: entry.type,
                nodeId: entry.nodeId,
                ...(entry.flowId === undefined ? {} : { flowId: entry.flowId }),
                at: this.deps.now().toISOString(),
                ok: entry.ok,
                detail: entry.detail,
                runId,
                ...(entry.failure === undefined ? {} : { failure: entry.failure }),
                // 子图的一格也要带上会话与产出：看板把子流程摊进同一张图之后，
                // 「点开这格看它产出了什么 / 跳到它起的会话」全靠这两个字段；
                // 以前只有主图那条 record 记，子图里点开是一片空白。
                ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
                ...(entry.data === undefined ? {} : { data: entry.data }),
              } as never)
              this.deps.changed()
            },
          })
          // 子图挂起不是失败：把它「在等什么」连同进度交给父图，父图照原样停在 workflow 这一格。
          if (nested.status === 'suspended') {
            const wait = nested.progress.pending
            return {
              ok: true,
              detail: `工作流 ${workflowId}：${wait?.detail ?? '在等信号'}`,
              wait: {
                on: wait?.on ?? 'event',
                ...(wait?.token === undefined ? {} : { token: wait.token }),
                ...(wait?.dueAt === undefined ? {} : { dueAt: wait.dueAt }),
                ...(wait?.resume === undefined ? {} : { resume: wait.resume }),
                detail: wait?.detail ?? `工作流 ${workflowId} 在等信号`,
                nested: { flowId: workflowId, progress: nested.progress },
              },
            }
          }
          return nested.status === 'done' || nested.status === 'skipped'
            ? { ok: true, detail: sub.name }
            : { ok: false, detail: nested.error ?? nested.matched ?? nested.status, failure: 'transient' as const }
        },
        ...(resuming && task.progress !== undefined ? { progress: task.progress } : {}),
        ...(signal === undefined ? {} : { signal }),
      },
      {
        registry: this.deps.nodes,
        dryRun: config.dryRun,
        log: line => this.deps.log(line),
        record: async (entry) => {
          await this.deps.store.appendNode(task.id, {
            id: `node-${randomUUID()}`,
            kind: entry.type,
            nodeId: entry.nodeId,
            ...(entry.flowId === undefined ? {} : { flowId: entry.flowId }),
            at: this.deps.now().toISOString(),
            ok: entry.ok,
            detail: entry.detail,
            runId,
            ...(entry.failure === undefined ? {} : { failure: entry.failure }),
            ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
            ...(entry.data === undefined ? {} : { data: entry.data }),
          })
          this.deps.changed()
        },
        saveProgress: async (progress) => {
          await this.deps.store.patch(task.id, { progress, status: 'running' })
        },
      },
    )

    const status = result.status === 'suspended'
      ? 'suspended'
      : result.status === 'done' ? 'done' : result.status
    await this.deps.store.patch(task.id, {
      status,
      progress: result.progress,
      updatedAt: this.deps.now().toISOString(),
    })
    if (result.error !== undefined) this.deps.warn(`流程图执行出错：${result.error}`)
    this.forgetClassifications(task.id)
    this.deps.changed()
  }

  /**
   * 把任务事件摊平成模板可见的字符串投影。
   *
   * 触发器的变量（`from` / `subject` / `repo`）在前，事件 payload 顶层的原始值在后——
   * 后者补上 `accountId` / `folder` / `uid` 这类节点要用的坐标。
   * @param task - 任务。
   * @returns 投影。
   */
  private projectEvent(task: Task): Record<string, string> {
    const out: Record<string, string> = { ...this.varsOf(task) }
    const payload = task.event.payload
    if (typeof payload === 'object' && payload !== null) {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
        else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
      }
    }
    out['taskId'] = task.id
    return out
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
    signal?: Readonly<Record<string, unknown>>,
  ): Promise<ActionRun> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return { ok: true, detail: '任务已经不在了' }
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
      return { ok: true, detail: '试运行：只记录，未执行' }
    }

    const action = this.deps.actions.get(spec.kind)
    if (action === undefined) {
      const detail = `本部署没有实现动作 ${spec.kind}`
      await write(false, detail, { failure: 'config' })
      return { ok: false, detail }
    }

    const delay = spec.delaySeconds ?? (action.sideEffect === true ? config.undoWindowSeconds : 0)
    // 醒来续跑这一格时动作早就派发过了：再排一次队等于同一件事做两遍。
    if (delay > 0 && signal === undefined) {
      const dueAt = new Date(this.deps.now().getTime() + delay * 1000).toISOString()
      const detail = `已排队，${String(delay)} 秒后执行（此前可撤销）`
      await this.deps.deferred.add({ taskId, nodeId, connector: connector.id, kind: 'delay', spec, dueAt })
      await write(true, detail)
      await this.deps.store.patch(taskId, { undoableUntil: dueAt })
      return { ok: true, detail }
    }

    const outcome = await action.run(spec, this.contextOf(task, ports, nodeId, spec.kind, signal))
    if (outcome.undo !== undefined) this.registerUndo(taskId, outcome.undo)
    await write(outcome.ok, outcome.detail, {
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    })
    // 续跑时会话节点第一遍就挂上了：再挂一格会让看板出现两个同名会话。
    if (outcome.sessionId !== undefined && signal === undefined) {
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
    // `wait` 一路往回传：图上会因此挂起，而不是把「派发成功」当成「做完了」。
    return {
      ok: outcome.ok,
      detail: outcome.detail,
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      ...(outcome.wait === undefined ? {} : { wait: outcome.wait }),
    }
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
    const woken = await this.wakeWaits(now)
    return due.length + woken
  }

  /**
   * 看一遍所有挂起的任务：超时的判失败，等到东西的唤醒。
   *
   * 谁来判「等到了」由连接器回答（`probeWait`）：核心不认识会话，也不该认识。
   * @param now - 现在。
   * @returns 被唤醒的任务数。
   */
  private async wakeWaits(now: Date): Promise<number> {
    const nowIso = now.toISOString()
    let woken = 0
    for (const task of this.deps.store.list()) {
      if (task.status !== 'suspended') continue
      const wait = task.progress?.pending
      if (wait === undefined) continue
      if (wait.dueAt !== undefined && wait.dueAt <= nowIso) {
        await this.appendNode(task, 'wait', false, `等超时：${wait.detail}`)
        await this.deps.store.patch(task.id, { status: 'failed', updatedAt: nowIso })
        this.deps.changed()
        continue
      }
      const probe = this.deps.connectors.get(task.connector)?.probeWait
      if (probe === undefined) continue
      let verdict: { readonly ready: boolean; readonly payload?: Readonly<Record<string, unknown>> } | undefined
      try {
        verdict = await probe(wait, task)
      } catch (error: unknown) {
        this.deps.warn(`探「${wait.detail}」时出错：${describe(error)}`)
        continue
      }
      if (verdict?.ready !== true) continue
      const result = await this.resume({
        taskId: task.id,
        token: wait.token,
        ...(verdict.payload === undefined ? {} : { payload: verdict.payload }),
        actor: 'probe',
      })
      if (result.ok) woken += 1
    }
    return woken
  }

  /**
   * 唤醒一条挂起的任务。
   *
   * 挂起是「这条链停在这一格，等一个信号」；唤醒就是把当初留的载荷交给它、让它从那一格
   * 接着跑。令牌对不上就拒绝——否则两条都在等的任务会互相唤醒。
   * @param input - 按任务或令牌找人，可带唤醒载荷。
   * @returns 结果与一句说明。
   */
  async resume(input: ResumeInput): Promise<UndoResult> {
    const task = input.taskId !== undefined ? this.deps.store.get(input.taskId) : this.findWait(input.token)
    if (task === undefined) {
      return { ok: false, message: input.token === undefined ? '没有这条任务' : '没有在等这个信号的任务' }
    }
    if (task.status !== 'suspended') return { ok: false, message: `任务 ${task.id} 不在等待状态（${task.status}）` }
    const wait = task.progress?.pending
    if (wait === undefined) return { ok: false, message: '这条任务没记下在等什么，没法唤醒' }
    if (input.token !== undefined && input.token !== wait.token) {
      return { ok: false, message: '信号对不上这条任务在等的东西' }
    }
    const signal: Record<string, unknown> = {
      ...(wait.resume ?? {}),
      ...(input.payload ?? {}),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      token: wait.token,
    }
    await this.appendNode(task, 'signal', true, `收到信号：${wait.detail}`)
    await this.runChain(task.id, signal)
    const after = this.deps.store.get(task.id)
    return { ok: true, message: `已唤醒，现在是 ${after?.status ?? 'done'}` }
  }

  /** 按令牌找在等它的那条任务。 */
  private findWait(token: string | undefined): Task | undefined {
    if (token === undefined) return undefined
    return this.deps.store.list().find(task => task.status === 'suspended' && task.progress?.pending?.token === token)
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
    signal?: Readonly<Record<string, unknown>>,
  ): TaskContext {
    return {
      task,
      event: task.event,
      vars: this.varsOf(task),
      node: { id: nodeId, kind },
      ports,
      ...(signal === undefined ? {} : { signal }),
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

/**
 * 分类缓存的键。
 *
 * 同一任务 + 同一问法（标签集与提示词都一样）才算同一件事：模型被问的是「从这些标签里
 * 选一个」，标签集变了答案就可能变，不能复用。标签顺序不影响问题本身，排序后再拼。
 * @param taskId - 任务 id。
 * @param labels - 这一条边声明的标签集。
 * @param prompt - 这一条边的提示词。
 * @returns 缓存键。
 */
function classificationKey(
  taskId: string,
  labels: readonly string[] | undefined,
  prompt: string | undefined,
): string {
  return `${taskId}\u0000${[...(labels ?? [])].sort().join('\u0000')}\u0000${prompt ?? ''}`
}

export type { NodeOutcome }
