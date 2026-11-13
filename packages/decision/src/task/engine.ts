/**
 * 任务引擎：把契约、注册表、存储与执行器装成一台能跑的机器。
 *
 * 它仍然**不认识任何来源**：不知道邮件、不知道会话、不知道 HTTP。它只做四件事：
 *
 * 1. 收连接器注册（触发器、动作、条件词表、端口、分类、建议、迁移）。
 * 2. 把多份词表合成**一份**规则文件语法（一份文件，多个连接器各认自己的 kind）。
 * 3. 读规则、跑链、落 `tasks.json`、执行到期动作、撤销与裁剪。
 * 4. 给页面一个只读视图（`view()`）与一组写操作（开关规则、改三态、调优先级）。
 *
 * 三条边界写在代码里而不是注释里：没有 `import` 任何连接器；没有出现 `mail` 这类
 * 领域词；端口一律从 `ports` 袋子里取。
 *
 * @module @free-lzj/dsh-decision/task/engine
 */

import { join } from 'node:path'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import type { DecisionConfigBase, RuleVocabulary } from '../config.ts'
import { DEFAULT_DECISION_CONFIG, isRecord } from '../config.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import {
  loadRuleFile, setConditionValues, setRuleEnabled, swapPriority, type EditResult,
} from '../rules.ts'
import type { Rule, RuleFileError } from '../types.ts'
import { existsSync } from 'node:fs'
import { readJson, writeTextFile } from '../store.ts'
import type { TaskConnector, TaskTestAnswer, TaskTestRef } from './connector.ts'
import type { EmitAck, TaskEvent } from './event.ts'
import type { ActionNode } from './node.ts'
import type { NodePatch, Task, TaskConnectorInfo, TaskState } from './record.ts'
import { OwnedRegistry, RegistrationConflict, TriggerRegistry } from './registry.ts'
import { TaskRunner, type UndoResult } from './runner.ts'
import { createTaskStore, forwardingStore, openTaskStore, type TaskStore } from './store.ts'
import { createDeferredStore, type DeferredStore } from './deferred.ts'
import type { TaskContext } from './context.ts'

/** connectors.json 的形状：哪些连接器参与规则。 */
interface ConnectorsFile {
  readonly version: 1
  readonly enabled: Readonly<Record<string, boolean>>
}

/** 认回开关文件；坏文件当作「全部参与」。 */
function parseConnectors(value: unknown): ConnectorsFile | undefined {
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['enabled'])) return undefined
  return { version: 1, enabled: value['enabled'] as Readonly<Record<string, boolean>> }
}

/** 规则文件的只读视图：规则页画的就是这一份。 */
export interface TaskRulesView {
  readonly rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[]
  /** 解析失败时的结构化错误；此时 `rules` 是上一份可用的。 */
  readonly error?: RuleFileError
  readonly source: 'file' | 'default'
  readonly path: string
  /** 文件原文，页面拿它做「复制给 agent 的修改指令」。 */
  readonly raw: string
  /** 被丢弃的条目说明（写歪的规则）。 */
  readonly dropped: readonly string[]
  /**
   * 没写归属、因而**永不执行**的规则条数。
   *
   * 页面上要说清这件事：一份文件里 20 条规则全都跑不动，和"规则写错了"是两种
   * 完全不同的故障，用户需要看到的是「它们缺 `connector`」。
   */
  readonly unassigned: number
  /** 有没有连接器挂上来。`false` 时页面要说「还没有连接器提供规则」。 */
  readonly connector: boolean
}

/** 一次写操作的结果。 */
export interface TaskEdit {
  readonly ok: boolean
  readonly message?: string
}

/** 造引擎时要的那几个值。 */
export interface TaskEngineOptions {
  /** 三份状态所在的目录（`rules.yml` / `tasks.json` / `deferred.json`）。 */
  readonly home: string
  /**
   * 判定配置；省略时用第一个连接器提供的（`mail` 的 `triage` 就是它）。
   *
   * 这个字段以前是必填的，但工作台并不持有这些开关——它们属于提供规则的连接器。
   */
  readonly config?: () => DecisionConfigBase
  readonly log?: (line: string) => void
  readonly warn?: (line: string) => void
  /** 现在；测试可以钉死。 */
  readonly now?: () => Date
  /** 到期扫描与保留裁剪的周期；测试可以调小。 */
  readonly dueIntervalMs?: number
}

/** 一台任务引擎。 */
export class TaskEngine {
  /** 状态目录。 */
  readonly home: string
  readonly rulesPath: string
  readonly tasksPath: string
  readonly deferredPath: string
  /** 连接器开关的持久化文件。 */
  readonly connectorsPath: string
  /** 迁移完成的标记：有它就不再翻旧文件。 */
  readonly migratedPath: string

  private readonly store: TaskStore
  /** 门面背后的真实实现：启动时可能从 JSON 换成 SQLite。 */
  private storeImpl: TaskStore
  private readonly deferred: DeferredStore
  private readonly triggers = new TriggerRegistry()
  private readonly actions = new OwnedRegistry<ActionNode<ActionSpecLike, TaskContext>>()
  private readonly connectors = new Map<string, TaskConnector>()
  /** 每个连接器参不参与规则；缺省在，关掉就是 false。 */
  private readonly enabled = new Map<string, boolean>()
  private readonly runner: TaskRunner
  private readonly undos = new Map<string, (() => Promise<void>)[]>()
  /** 有多少条规则没写归属（它们不会执行）。 */
  private unassigned = 0

  private currentRules: readonly Rule<ConditionSpecLike, ActionSpecLike>[] = []
  private rulesError: RuleFileError | undefined
  private rulesSource: 'file' | 'default' = 'default'
  private dropped: readonly string[] = []
  private started = false
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private version = 0
  private readonly listeners = new Set<(state: TaskState) => void>()

  /**
   * @param options - 数据目录、配置与日志出口。
   */
  constructor(private readonly options: TaskEngineOptions) {
    this.home = options.home
    this.rulesPath = join(options.home, 'rules.yml')
    this.tasksPath = join(options.home, 'tasks.json')
    this.deferredPath = join(options.home, 'deferred.json')
    this.connectorsPath = join(options.home, 'connectors.json')
    this.migratedPath = join(options.home, 'migrated.json')
    // 两个仓在构造时就绑定路径（`createTaskStore` 只存路径，不读盘）。
    // 启动前的占位；start() 会探测 SQLite 并用门面切换过去（JSON 随时可回落）。
    this.storeImpl = createTaskStore(this.tasksPath)
    this.store = forwardingStore(() => this.storeImpl)
    this.deferred = createDeferredStore(this.deferredPath)
    this.runner = new TaskRunner({
      store: this.store,
      deferred: this.deferred,
      triggers: this.triggers,
      actions: this.actions,
      connectors: this.connectors,
      rules: () => this.currentRules,
      config: () => this.configOf(),
      log: line => this.log(line),
      warn: line => this.warn(line),
      now: () => options.now?.() ?? new Date(),
      changed: () => { this.bump() },
      undos: this.undos,
    })
  }

  /**
   * 注册一个连接器；同一个 id 重复注册 = 热重载幂等。
   * @param connector - 连接器。
   * @returns 注销函数。
   */
  register(connector: TaskConnector): () => void {
    const previous = this.connectors.get(connector.id)
    if (previous !== undefined) this.unregister(connector.id)
    this.connectors.set(connector.id, connector)
    if (!this.applyRegistration(connector)) {
      // 冲突时整块回退，并且**不留在连接器列表里**：一个什么都没注册成功的条目，
      // 在页面上只会被读成「它在这儿、只是没生效」。
      this.connectors.delete(connector.id)
      return () => undefined
    }
    // 连接器可能比引擎晚 mount：它的 `migration` 定义只在注册之后才在表里，
    // 所以迁移得在每次注册后再试一次（有标记文件时是空转）。
    if (this.started) void this.migrate()
    this.log(`任务引擎: 连接器 ${connector.id} 已注册（触发器 ${String(connector.triggers.length)}、动作 ${String(connector.actions.length)}${this.isEnabled(connector.id) ? '' : '，当前关闭'}）`)
    if (this.started) void this.reloadRules()
    this.bump()
    return () => { this.unregister(connector.id) }
  }

  /**
   * 按开关状态把连接器的触发器与动作装进注册表（或撤掉）。
   *
   * 关掉一个连接器**不动插件**：它的面板、它的邮箱连接都还在，只是规则不再从它的
   * 事件里派活、它的动作也不再对规则可用。冲突时整块回退并告警——半个连接器比没有
   * 更难查。
   * @param connector - 连接器。
   * @returns 装上了（或本来就该是空的）就 true；冲突回退就 false。
   */
  private applyRegistration(connector: TaskConnector): boolean {
    this.triggers.clear(connector.id)
    this.actions.clear(connector.id)
    if (!this.isEnabled(connector.id)) return true
    try {
      for (const trigger of connector.triggers) this.triggers.register(connector.id, trigger)
      for (const action of connector.actions) this.actions.register(connector.id, action)
      return true
    } catch (error: unknown) {
      this.triggers.clear(connector.id)
      this.actions.clear(connector.id)
      if (error instanceof RegistrationConflict) this.warn(`连接器 ${connector.id} 注册被拒绝：${error.message}`)
      else this.warn(`连接器 ${connector.id} 注册失败：${describe(error)}`)
      return false
    }
  }

  /**
   * 打开或关掉一个连接器的规则参与。
   * @param id - 连接器 id。
   * @param enabled - 参不参与。
   * @returns 结果；不认识这个 id、或重新打开时撞上 kind 冲突，都算失败。
   */
  async setConnectorEnabled(id: string, enabled: boolean): Promise<TaskEdit> {
    const connector = this.connectors.get(id)
    if (connector === undefined) return { ok: false, message: `不认识连接器 ${id}` }
    const previous = this.isEnabled(id)
    this.enabled.set(id, enabled)
    if (!this.applyRegistration(connector)) {
      // 打不开就退回原状：留着「开着但没生效」比关着更难解释。
      this.enabled.set(id, previous)
      this.applyRegistration(connector)
      await this.persistConnectors()
      this.bump()
      return { ok: false, message: '这个连接器的动作和别的连接器撞了，没能改过来' }
    }
    await this.persistConnectors()
    await this.reloadRules()
    this.bump()
    return { ok: true }
  }

  /** 一个连接器现在参不参与规则（缺省参与）。 */
  private isEnabled(id: string): boolean {
    return this.enabled.get(id) !== false
  }

  /** 摘掉一个连接器的全部注册；状态留在磁盘上。 */
  private unregister(id: string): void {
    this.connectors.delete(id)
    this.triggers.clear(id)
    this.actions.clear(id)
    if (this.started) void this.reloadRules()
  }

  /** 启动：读状态、迁移、读规则、开始监听与到期扫描。 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const opened = await openTaskStore({
        dir: this.options.home,
        file: this.tasksPath,
        log: line => this.log(line),
      })
      this.storeImpl = opened.store
      await this.store.load()
      this.log(
        '任务仓: ' + (opened.kind === 'sqlite' ? 'SQLite（tasks.db）' : 'JSON（tasks.json）')
        + '，' + String(this.store.count()) + ' 条任务',
      )
      await this.deferred.load()
      await this.loadConnectors()
      // 开关可能比 `register` 晚读到：按读到的状态重放一次注册。
      for (const connector of [...this.connectors.values()]) {
        if (!this.applyRegistration(connector)) this.connectors.delete(connector.id)
      }
      await this.migrate()
      await this.reloadRules()
      this.watchRules()
      this.startTimer()
    } catch (error: unknown) {
      this.warn(`任务引擎: 启动失败：${describe(error)}`)
    }
  }

  /** 读连接器开关；坏文件回落成「全部参与」。 */
  private async loadConnectors(): Promise<void> {
    const file = await readJson<ConnectorsFile>(this.connectorsPath, parseConnectors, { version: 1, enabled: {} })
    for (const [id, on] of Object.entries(file.enabled)) this.enabled.set(id, on === true)
  }

  /** 写连接器开关。 */
  private async persistConnectors(): Promise<void> {
    const enabled: Record<string, boolean> = {}
    for (const [id, on] of this.enabled) enabled[id] = on
    await writeTextFile(this.connectorsPath, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`)
  }

  /** 停掉监听与定时器；三份状态留在磁盘上。 */
  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.watcher?.close()
    this.watcher = undefined
  }

  /** 发布一个事件。 */
  async emit(event: TaskEvent): Promise<EmitAck> {
    return await this.runner.emit(event)
  }

  /** 回写一格的状态（会话 turn/end、外部进度）。 */
  async patchNode(taskId: string, nodeId: string, patch: NodePatch): Promise<boolean> {
    const updated = await this.store.patchNode(taskId, nodeId, patch)
    if (updated === undefined) return false
    this.bump()
    return true
  }

  /** 撤销一个任务。 */
  async undo(taskId: string): Promise<UndoResult> {
    return await this.runner.undo(taskId)
  }

  /** 记下「这个任务我看到了」。 */
  async acknowledge(taskId: string, acknowledged = true): Promise<TaskEdit> {
    const updated = await this.store.patch(taskId, { acknowledged })
    if (updated === undefined) return { ok: false, message: `找不到任务 ${taskId}` }
    this.bump()
    return { ok: true }
  }

  /** 执行一条排队项（建议被批准时用）。 */
  async applyDeferred(deferredId: string): Promise<UndoResult> {
    return await this.runner.applyDeferred(deferredId)
  }

  /** 执行到期的延迟动作。 */
  async runDue(now: Date = this.options.now?.() ?? new Date()): Promise<number> {
    return await this.runner.runDue(now)
  }

  /** 等所有在跑的链结束；测试用。 */
  async flush(): Promise<void> {
    await this.runner.flush()
  }

  /**
   * 会话属于哪个任务。
   *
   * 会话节点（或建了会话的动作）带着 `sessionId`，所以「这条会话是谁派出来的」是
   * 一次遍历能回答的问题。通知与工具据此把后续的事挂回原来那条链。
   * @param sessionId - 宿主会话 id。
   * @returns 任务，或 undefined（这条会话不归任何任务）。
   */
  taskOfSession(sessionId: string): Task | undefined {
    if (sessionId === '') return undefined
    return this.store.list().find(task => task.nodes.some(node => node.sessionId === sessionId))
  }

  /** 看板与连接器页读的那份快照。 */
  view(): TaskState {
    return {
      tasks: this.store.list(),
      connectors: [...this.connectors.values()].map(connector => this.infoOf(connector)),
      revision: this.version,
    }
  }

  /**
   * 任务列表，最新在前。
   * @param since - 只给这条之后的（不含它）；没有时给最近一批。
   * @returns 任务。
   */
  listRuns(since?: string): readonly Task[] {
    const all = this.store.list()
    if (since === undefined) return all.slice(0, 100)
    const at = all.findIndex(task => task.id === since)
    return at === -1 ? all.slice(0, 100) : all.slice(0, at)
  }

  /** 规则文件的只读视图。 */
  rules(): TaskRulesView {
    const connected = this.connectors.size > 0
    return {
      rules: this.currentRules,
      ...(this.rulesError === undefined ? {} : { error: this.rulesError }),
      source: this.rulesSource,
      path: this.rulesPath,
      raw: connected ? this.rawRules() : '',
      dropped: this.dropped,
      unassigned: this.unassigned,
      connector: connected,
    }
  }

  /** 订阅结构变化。 */
  subscribe(listener: (state: TaskState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /* ─────────────────────────────── 规则写操作 ─────────────────────────────── */

  async setEnabled(id: string, enabled: boolean): Promise<TaskEdit> {
    return await this.applyEdit(raw => setRuleEnabled(raw, id, enabled))
  }

  async setConditionValues(id: string, conditionIndex: number, values: readonly string[]): Promise<TaskEdit> {
    return await this.applyEdit(raw => setConditionValues(raw, id, conditionIndex, values))
  }

  async movePriority(id: string, direction: 'up' | 'down'): Promise<TaskEdit> {
    return await this.applyEdit(raw => swapPriority(raw, id, this.currentRules, direction))
  }

  /** 拿一条真实事件试跑；引擎不认识事件，所以由连接器回答。 */
  async test(ref: TaskTestRef): Promise<TaskTestAnswer> {
    for (const connector of this.connectors.values()) {
      if (connector.test === undefined) continue
      return await connector.test(ref, this.currentRules)
    }
    return { ok: false, message: '还没有连接器能试跑事件' }
  }

  /* ─────────────────────────────── 内部 ─────────────────────────────── */

  /** 重新读规则；成功才替换当前生效的那一份。 */
  private async reloadRules(): Promise<void> {
    const vocabulary = this.combinedVocabulary()
    if (vocabulary === undefined) return
    // 不猜归属：没有 connector 的规则**永不执行**，并在下面如实告警。猜一次就会把
    // 邮件规则挂到别的域上，跑出一堆莫名其妙的失败动作。
    const loaded = await loadRuleFile(this.rulesPath, this.combinedDefaultRules(), vocabulary)
    if (loaded.error !== undefined) {
      // 解析失败**保留上一份**：整份回退默认规则会让用户以为自己的规则生效了。
      this.rulesError = loaded.error
      this.warn(`任务引擎: 规则文件有问题，已保留上一份可用规则：${loaded.error.message}`)
      return
    }
    this.currentRules = loaded.rules
    this.rulesSource = loaded.source
    this.unassigned = loaded.rules.filter(rule => rule.connector === undefined).length
    if (this.unassigned > 0) {
      this.warn(
        '任务引擎: ' + String(this.unassigned) + ' 条规则没有写 connector，它们不会执行——'
        + '在文件顶部加一行 connector: mail（或给单条规则写），全局兜底写 connector: \'*\'',
      )
    }
    this.dropped = loaded.dropped
    this.rulesError = undefined
    if (loaded.legacyModes > 0) {
      this.warn(
        `任务引擎: 规则文件里还有 ${String(loaded.legacyModes)} 个动作写着已移除的 mode——`
        + '动作开关没有了：mode: off 的动作按删除处理，其它值按照常执行处理。'
        + '要让一个动作不跑，把它从 then 里删掉。',
      )
    }
    for (const note of this.dropped) this.warn(`任务引擎: 丢弃了一条规则（${note}）`)
    this.log(`任务引擎: 已加载 ${String(this.currentRules.length)} 条规则（来源：${this.rulesSource}）`)
    this.bump()
  }

  /**
   * 把多份词表合成一份规则文件语法。
   *
   * 契约：每个连接器的 `normalizeCondition` / `normalizeAction` **只认自己的 kind**，
   * 别人的返回 undefined。于是「依次问」不会产生歧义，而规则文件仍然只有一份。
   */
  private combinedVocabulary(): RuleVocabulary<ConditionSpecLike, ActionSpecLike> | undefined {
    const connectors = [...this.connectors.values()]
    const first = connectors[0]
    if (first === undefined) return undefined
    return {
      normalizeCondition(input) {
        for (const connector of connectors) {
          const parsed = connector.vocabulary.normalizeCondition(input)
          if (parsed !== undefined) return parsed
        }
        return undefined
      },
      normalizeAction(input) {
        for (const connector of connectors) {
          const parsed = connector.vocabulary.normalizeAction(input)
          if (parsed !== undefined) return parsed
        }
        return undefined
      },
      validate(rules) {
        for (const connector of connectors) {
          const own = rules.filter(rule => rule.connector === connector.id)
          const problem = connector.vocabulary.validate?.(own)
          if (problem !== undefined) return problem
        }
        return undefined
      },
    }
  }

  /** 发货默认规则：只有一个连接器带非空默认文件时用它，多个时取第一个并告警。 */
  private combinedDefaultRules(): string {
    const texts = [...this.connectors.values()]
      .map(connector => connector.defaultRules.trim())
      .filter(text => text !== '' && text !== 'version: 1\nrules: []')
    const first = texts[0]
    if (first === undefined) return 'version: 1\nrules: []\n'
    if (texts.length > 1) {
      this.warn(`任务引擎: 有 ${String(texts.length)} 个连接器提供默认规则，只写第一份`)
    }
    return first
  }

  /** 规则文件是 agent 改的，所以必须监听：改完不用重启就生效。 */
  private watchRules(): void {
    if (this.watcher !== undefined) return
    try {
      this.watcher = watch(this.rulesPath, { persistent: false }, () => {
        // 编辑器保存常常写两次（临时文件 + 改名），防抖一下免得读半份。
        setTimeout(() => { void this.reloadRules() }, 300)
      })
    } catch {
      // 监听不上只意味着改规则要重启，不该让引擎起不来。
    }
  }

  /** 到期扫描 + 按保留策略裁剪记录（两个配置项只写不裁就是假配置）。 */
  private startTimer(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.runner.runDue().catch((error: unknown) => this.warn(`任务引擎: 执行延迟动作失败：${describe(error)}`))
      const config = this.configOf()
      void this.store.trim({ limit: config.runHistoryLimit, days: config.runRetentionDays }, new Date())
        .catch((error: unknown) => this.warn(`任务引擎: 裁剪任务失败：${describe(error)}`))
    }, this.options.dueIntervalMs ?? 15_000)
    this.timer.unref?.()
  }

  /**
   * 旧命中记录的迁移。
   *
   * 判断「迁过没有」用**标记文件**，不是 `tasks.json` 非空：新引擎一跑就会有新
   * 任务，用非空当判据等于把旧数据永久关在门外（2026-11-10 真机踩到：43 条老
   * 记录一直没进来）。
   *
   * 而且它必须能在**连接器注册之后**再试一次：`start()` 那一刻外部连接器还没
   * mount，它们的 `migration` 定义根本不在表里。
   */
  private async migrate(): Promise<void> {
    if (existsSync(this.migratedPath)) return
    for (const connector of this.connectors.values()) {
      const migration = connector.migration
      if (migration === undefined) continue
      let raw: string
      try {
        raw = readFileSync(migration.path, 'utf8')
      } catch {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.warn(`任务引擎: 旧记录 ${migration.path} 不是合法 JSON，跳过迁移`)
        continue
      }
      const records = isRecord(parsed) && Array.isArray(parsed['runs'])
        ? parsed['runs']
        : Array.isArray(parsed) ? parsed : []
      const tasks: Task[] = []
      for (const record of records) {
        const task = migration.toTask(record)
        if (task !== undefined) tasks.push(task)
      }
      if (tasks.length === 0) continue
      const imported = await this.store.importTasks(tasks)
      await writeTextFile(this.migratedPath, `${JSON.stringify({ from: migration.path, imported }, null, 2)}\n`)
      this.warn(`任务引擎: 已把 ${String(imported)} 条旧命中记录迁成任务（${migration.path}，旧文件未删）`)
    }
  }

  /** 读规则文件的原文；给页面做「复制给 agent」用。 */
  private rawRules(): string {
    try {
      return readFileSync(this.rulesPath, 'utf8')
    } catch {
      return ''
    }
  }

  /** 把规则文件改一处并立刻生效。 */
  private async applyEdit(edit: (raw: string) => EditResult): Promise<TaskEdit> {
    if (this.connectors.size === 0) return { ok: false, message: '还没有连接器提供规则' }
    const raw = this.rawRules()
    if (raw === '') return { ok: false, message: `读不到规则文件：${this.rulesPath}` }
    const result = edit(raw)
    if (!result.ok) return { ok: false, message: result.error }
    await writeTextFile(this.rulesPath, result.text)
    await this.reloadRules()
    return { ok: true }
  }

  /** 一个连接器在页面上的形状。 */
  private infoOf(connector: TaskConnector): TaskConnectorInfo {
    return {
      id: connector.id,
      label: connector.label,
      directions: connector.directions,
      implemented: connector.implemented,
      enabled: this.isEnabled(connector.id),
      ...(connector.note === undefined ? {} : { note: connector.note }),
      triggers: connector.triggers.map(trigger => trigger.id),
      actions: connector.actions.map(action => action.kind),
    }
  }

  /** 推进版本并推给订阅者。 */
  private bump(): void {
    this.version += 1
    const state = this.view()
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error: unknown) {
        this.warn(`任务引擎: 订阅者出错：${describe(error)}`)
      }
    }
  }

  /** 判定配置：显式给的优先，否则用第一个连接器提供的那份。 */
  private configOf(): DecisionConfigBase {
    if (this.options.config !== undefined) return this.options.config()
    for (const connector of this.connectors.values()) {
      if (connector.decisionConfig !== undefined) return connector.decisionConfig()
    }
    return DEFAULT_DECISION_CONFIG
  }

  /** 一句日志。 */
  private log(line: string): void {
    this.options.log?.(line)
  }

  private warn(line: string): void {
    this.options.warn?.(line)
  }
}

/** 一个抛出物作为一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
