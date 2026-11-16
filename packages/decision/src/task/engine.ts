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
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { parseDocument as parseYaml } from 'yaml'
import type { DecisionConfigBase, RuleVocabulary } from '../config.ts'
import { DEFAULT_DECISION_CONFIG, isRecord } from '../config.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import {
  loadRuleFile, setConditionValues, setRuleEnabled, swapPriority, type EditResult,
} from '../rules.ts'
import type { Rule, RuleFileError } from '../types.ts'

import { readJson, writeTextFile } from '../store.ts'
import type { TaskConnector, TaskTestAnswer, TaskTestRef } from './connector.ts'
import type { EmitAck, TaskEvent } from './event.ts'
import type { ActionNode } from './node.ts'
import type { NodePatch, Task, TaskConnectorInfo, TaskState } from './record.ts'
import { OwnedRegistry, RegistrationConflict, TriggerRegistry } from './registry.ts'
import { TaskRunner, type UndoResult } from './runner.ts'
import { createTaskStore, forwardingStore, openTaskStore, type TaskStore } from './store.ts'
import { createDeferredStore, type DeferredStore } from './deferred.ts'
import { actionsToFlowNodes } from '../flow/adapt.ts'
import { createControlNodes } from '../flow/control.ts'
import { parseFlowDocument, parseFlowFile } from '../flow/parse.ts'
import { resolvePositions } from '../flow/layout.ts'
import { FlowNodeRegistry } from '../flow/registry.ts'
import type { Flow } from '../flow/types.ts'
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
  /**
   * 这份文件是节点图格式（`version: 2`）。
   *
   * 此时 `rules` 是空的**而且这是对的**：规则写在图里，不在 `rules:` 数组里。页面要
   * 据此说「去看编排」，而不是「一条规则也没有」——后者会让用户以为规则丢了。
   */
  readonly flowMode?: boolean
}

/** 每张图共有的入口节点；聚焦某条规则时它们一起保留。 */
const SHARED_FLOW_NODES = new Set(['start', 'classify', 'route', 'rest'])

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
  /** 图节点类型：内置控制流 + 各连接器贡献的。 */
  private readonly nodes = new FlowNodeRegistry()
  /** 当前生效的流程图；v1 文件时为空数组。 */
  private currentFlows: readonly Flow[] = []
  /** 图 id → 它来自哪个文件；保存时按这个写回去。 */
  private flowFiles: ReadonlyMap<string, string> = new Map()
  /** 一规则一文件所在的目录。 */
  private readonly flowsDir: string
  /** 事件流目录：一个事件一个文件。 */
  private readonly eventsDir: string
  /** 子工作流目录：可被事件流里的 workflow 节点引用。 */
  private readonly workflowsDir: string
  /** 子工作流：id → 图。事件流里的 workflow 节点按 id 引用它。 */
  private workflows = new Map<string, Flow>()
  /** 事件流：trigger id → 图。事件到达时按 `task.triggerId` 取那张。 */
  private eventFlows = new Map<string, Flow>()
  private readonly runner: TaskRunner
  private readonly undos = new Map<string, (() => Promise<void>)[]>()
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
    // 一规则一文件：每张图一个 .yml，放在这个目录下；rules.yml 只是迁移前的旧家。
    this.flowsDir = join(options.home, 'flows')
    this.eventsDir = join(options.home, 'events')
    this.workflowsDir = join(options.home, 'workflows')
    this.tasksPath = join(options.home, 'tasks.json')
    this.deferredPath = join(options.home, 'deferred.json')
    this.connectorsPath = join(options.home, 'connectors.json')
    this.migratedPath = join(options.home, 'migrated.json')
    // 两个仓在构造时就绑定路径（`createTaskStore` 只存路径，不读盘）。
    // 启动前的占位；start() 会探测 SQLite 并用门面切换过去（JSON 随时可回落）。
    this.storeImpl = createTaskStore(this.tasksPath)
    this.store = forwardingStore(() => this.storeImpl)
    this.deferred = createDeferredStore(this.deferredPath)
    this.nodes.registerAll('core', createControlNodes())
    this.runner = new TaskRunner({
      store: this.store,
      deferred: this.deferred,
      triggers: this.triggers,
      actions: this.actions,
      connectors: this.connectors,
      rules: () => this.currentRules,
      flows: () => this.currentFlows,
      eventFlowOf: triggerId => this.eventFlows.get(triggerId),
      workflowOf: id => this.workflows.get(id),
      nodes: this.nodes,
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
    this.registerNodes(connector)
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
   * 读一规则一文件的目录：`flows/` 下每个 `.yml` 就是一张图。
   *
   * 一个文件读不出来**不影响别的文件**：坏的那张单独告警跳过，其余照常生效。
   * 这和「一份大文件里坏一条就整份拒绝」不一样——文件既然分开了，就没道理互相牵连。
   * @param vocabulary - 合并后的词表。
   * @returns 图列表与「图 id → 文件路径」的映射。
   */
  private readDirFlows(dir: string, vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>): {
    readonly flows: readonly Flow[]
    readonly files: ReadonlyMap<string, string>
  } {
    if (!existsSync(dir)) return { flows: [], files: new Map() }

    let names: string[] = []
    try {
      names = readdirSync(dir)
        .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
        .sort()
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.warn('任务引擎: 读不了目录 ' + dir + '（' + detail + '）')
      return { flows: [], files: new Map() }
    }

    const flows: Flow[] = []
    const files = new Map<string, string>()
    for (const name of names) {
      const path = join(dir, name)
      let raw = ''
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        this.warn('任务引擎: ' + name + ' 读不了，跳过')
        continue
      }
      const parsed = parseFlowDocument(raw, this.nodes, vocabulary)
      if (parsed.error !== undefined || parsed.flow === undefined) {
        this.warn('任务引擎: ' + name + ' 读不出来（' + (parsed.error?.message ?? '没有图') + '），跳过')
        continue
      }
      for (const note of parsed.dropped) this.warn('任务引擎: ' + name + ' 有一项被丢弃（' + note + '）')
      if (files.has(parsed.flow.id)) {
        this.warn('任务引擎: 图 id「' + parsed.flow.id + '」重复，' + name + ' 跳过')
        continue
      }
      flows.push(parsed.flow)
      files.set(parsed.flow.id, path)
    }
    return { flows, files }
  }

  /**
   * 试着把同一份文件读成节点图。
   *
   * 读不出来时**返回空**而不是报错：迁移完成前 ersion: 1 是合法状态，此时走旧的
   * 规则列表路径。真正的语法错误由上面的 loadRuleFile 报，这里只负责能不能读成图。
   * @param raw - 规则文件原文。
   * @param vocabulary - 合并后的词表。
   * @returns 图列表；v1 或读不出时为空。
   */
  private parseFlows(raw: string, vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>): readonly Flow[] {
    if (raw.trim() === '') return []
    const parsed = parseFlowFile(raw, this.nodes, vocabulary)
    if (parsed.error !== undefined) {
      if (parsed.legacy !== true) this.warn('任务引擎: 流程图读不出来（继续用旧规则）：' + parsed.error.message)
      return []
    }
    for (const note of parsed.dropped) this.warn('任务引擎: 流程图里丢弃了一项（' + note + '）')
    if (parsed.flows.length > 0) {
      this.log('任务引擎: 已加载 ' + String(parsed.flows.length) + ' 张流程图')
    }
    return parsed.flows
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
  /**
   * 把连接器贡献的图节点装进注册表。
   *
   * 冲突（另一个连接器已经占了同名 type）时**只告警不中断**：它的旧动作仍然可用，
   * 一条图节点的重名不该让整个连接器消失。
   * @param connector - 连接器。
   */
  private registerNodes(connector: TaskConnector): void {
    // 显式注册的图节点 + 旧动作适配出来的节点。少了后半截，notify / session 这些
    // 只有 action 没有 node 的动作在迁移后的图上就会「没有注册」。
    // 顺序有讲究：显式 nodes 排在后、覆盖同名的适配版——连接器既给了 nodes 又留了
    // 同名旧 action 时，前者是它对新世界的表达，后者只是过渡期的影子。
    // ction 时，前者是它对新世界的表达，后者只是过渡期的影子，不该盖掉前者。
    const nodes = [...actionsToFlowNodes(connector.actions), ...(connector.nodes ?? [])]
    if (nodes.length === 0) return
    try {
      this.nodes.registerAll(connector.id, nodes)
    } catch (error: unknown) {
      this.warn(
        '任务引擎: 连接器 ' + connector.id + ' 的图节点没有全部注册：'
        + (error instanceof Error ? error.message : String(error)),
      )
      // 回退到「已注册成功的那部分」——registerAll 冲突时自己删掉了本轮新增。
    }
  }

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
  async patchNode(taskId: string, nodeId: string, patch: NodePatch): Promise<boolean> {    const updated = await this.store.patchNode(taskId, nodeId, patch)
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
      // 事件流存在时，规则列表为空是**对的**（规则在图里），页面据此说「去看编排」。
      ...(this.currentFlows.length === 0 && this.eventFlows.size === 0 ? {} : { flowMode: true }),
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

  /**
   * 当前生效的图，带**算好的坐标**，给画布。
   *
   * 人摆过的 `pos` 原样返回；没有的用 `resolvePositions` 补——补出来的坐标不进文件，
   * 所以刷新一次不会把文件写脏。
   * @returns 图列表与错误说明。
   */
  /** 某个触发器对应的事件流图；没有就 undefined。 */
  eventFlowOf(triggerId: string): Flow | undefined {
    return this.eventFlows.get(triggerId)
  }

  /** 全部事件流（界面列 tab 用）。 */
  eventFlowList(): readonly Flow[] {
    return [...this.eventFlows.values()]
  }

  /** 按 id 取子工作流。 */
  workflowOf(id: string): Flow | undefined {
    return this.workflows.get(id)
  }

  /** 全部子工作流。 */
  workflowList(): readonly Flow[] {
    return [...this.workflows.values()]
  }

  flowView(focus?: string): { readonly flows: readonly Flow[]; readonly error?: string } {
    // 事件流与子工作流优先；`flows/` 是老结构，迁移完就该空了。
    const source = this.eventFlows.size + this.workflows.size > 0
      ? [...this.eventFlows.values(), ...this.workflows.values()]
      : this.currentFlows
    const flows = source.map(flow => {
      // 聚焦某条规则时**先筛再算坐标**：否则节点会散落在总览时的旧位置上，
      // 布局要按真正要画的那些节点重新来。
      const nodes = focus === undefined || focus === ''
        ? flow.nodes
        : flow.nodes.filter(node => SHARED_FLOW_NODES.has(node.id) || node.id.startsWith(focus + '__'))
      const scoped: Flow = { ...flow, nodes }
      const positions = resolvePositions(scoped)
      return {
        ...scoped,
        nodes: nodes.map(node => ({
          ...node,
          pos: node.pos ?? positions.get(node.id) ?? { x: 0, y: 0 },
        })),
      }
    })
    return this.rulesError === undefined ? { flows } : { flows, error: this.rulesError.message }
  }

  /**
   * 已注册的节点类型清单，给属性面板与「能放什么」。
   * @returns 每种节点的标签、类别、配置表与产出。
   */
  nodeTypes(): readonly {
    readonly type: string
    readonly label: string
    readonly group: string
    readonly sideEffect: boolean
    readonly config?: Record<string, unknown>
    readonly outputs?: readonly { readonly key: string; readonly label?: string; readonly persist?: boolean }[]
    readonly runners?: readonly { readonly id: string; readonly label: string }[]
  }[] {
    return this.nodes.list().map(node => ({
      type: node.type,
      label: node.label,
      group: node.group,
      sideEffect: node.sideEffect === true,
      ...(node.config === undefined ? {} : { config: { ...node.config } }),
      ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
      ...(node.runners === undefined ? {} : { runners: node.runners.map(runner => ({ id: runner.id, label: runner.label })) }),
    }))
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

    // 子工作流与事件流：新结构。先读子工作流，事件流里的 workflow 节点要按 id 引用它。
    const wfDir = this.readDirFlows(this.workflowsDir, vocabulary)
    this.workflows = new Map(wfDir.flows.map(flow => [flow.id, flow]))

    const evDir = this.readDirFlows(this.eventsDir, vocabulary)
    this.eventFlows = new Map()
    for (const flow of evDir.flows) {
      if (flow.trigger === undefined) {
        this.warn('任务引擎: 事件流「' + flow.id + '」没写 trigger，跳过（它接不到任何事件）')
        continue
      }
      if (this.eventFlows.has(flow.trigger)) {
        this.warn('任务引擎: 触发器「' + flow.trigger + '」有两个事件流，' + flow.id + ' 被跳过')
        continue
      }
      this.eventFlows.set(flow.trigger, flow)
    }
    // **事件流存在就到此为止**：不再往下读 `rules.yml`。
    //
    // 那份文件是连接器发的「默认规则」（第一次启动时写下来当样例）。继续读会把
    // `currentRules` / `currentFlows` 覆盖成默认那 8 条，于是页面显示的根本不是用户
    // 的规则，回退路径也会拿默认图去跑。
    if (this.eventFlows.size > 0 || this.workflows.size > 0) {
      this.currentRules = []
      this.currentFlows = []
      this.flowFiles = evDir.files
      this.unassigned = 0
      this.dropped = []
      this.rulesError = undefined
      this.rulesSource = 'file'
      this.log(
        '任务引擎: 事件流 ' + String(this.eventFlows.size) + ' 张，子工作流 ' + String(this.workflows.size) + ' 个',
      )
      this.bump()
      return
    }

    // **一规则一文件优先**：`flows/` 里每个 `.yml` 是一张图。目录不存在或为空时才回退到
    // 旧的 `rules.yml`（那里可能还躺着一张合集图，等迁移脚本拆开）。
    const fromDir = this.readDirFlows(this.flowsDir, vocabulary)
    if (fromDir.flows.length > 0) {
      this.currentFlows = fromDir.flows
      this.flowFiles = fromDir.files
      this.currentRules = []
      this.unassigned = 0
      this.dropped = []
      this.rulesError = undefined
      this.rulesSource = 'file'
      this.log('任务引擎: 已加载 ' + String(fromDir.flows.length) + ' 张流程图（每规则一个文件）')
      this.bump()
      return
    }
    this.flowFiles = new Map()

    // **先看是不是节点图**。v2 文件没有 `rules:` 数组，走下面的 loadRuleFile 会被判成
    // 「顶层不是数组」而整份拒绝——所以顺序不能反：能读成图就只走图。
    const raw = this.rawRules()
    const flows = this.parseFlows(raw, vocabulary)
    this.currentFlows = flows
    if (flows.length > 0) {
      this.currentRules = []
      this.unassigned = 0
      this.dropped = []
      this.rulesError = undefined
      this.rulesSource = 'file'
      this.bump()
      return
    }

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
  /**
   * 改图上一个节点。
   *
   * 只改**指定的那个节点、指定的那几个字段**：整图交上来再写回去会覆盖别人同时做的
   * 改动，也会把文件里现有的注释与锚点冲掉。用 YAML 的 `Document` 就地改，注释、
   * 键序、`&anchor` 都原样留着。
   *
   * 改完立刻生效（重新解析并推送），不需要人再点一次刷新。
   * @param input - 哪个节点、改什么。
   * @returns 成功，或为什么没改成。
   */
  async saveFlowNode(input: {
    readonly nodeId: string
    /** 这个节点在哪张图里。`trigger` 这类 id 每张图都有，只按 id 找会写错文件。 */
    readonly flowId?: string
    readonly config?: Readonly<Record<string, unknown>>
    readonly pos?: { readonly x: number; readonly y: number }
    readonly label?: string
    readonly enabled?: boolean
  }): Promise<TaskEdit> {
    // 一规则一文件：写到**这个节点所在的那个文件**去。
    const located = this.locateFlow(input.nodeId, input.flowId)
    const path = located?.path ?? this.rulesPath
    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: `读不到规则文件：${path}` }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: `规则文件读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: `规则文件有语法错误，先修好它：${doc.errors[0]?.message ?? ''}` }
    }

    const found = locateNode(doc, input.nodeId)
    if (found === undefined) {
      return { ok: false, message: `文件里找不到节点「${input.nodeId}」——它可能刚被别处删掉了` }
    }
    const { flowIndex, nodeIndex } = found
    const at = (key: string): (string | number)[] => flowIndex < 0 ? ['nodes', nodeIndex, key] : ['flows', flowIndex, 'nodes', nodeIndex, key]

    if (input.config !== undefined) doc.setIn(at('config'), input.config)
    if (input.pos !== undefined) doc.setIn(at('pos'), { x: input.pos.x, y: input.pos.y })
    if (input.label !== undefined) doc.setIn(at('label'), input.label)
    if (input.enabled !== undefined) {
      // 启用时不写 `enabled: true`——文件里只该出现「关掉了」这个例外。
      if (input.enabled) doc.deleteIn(at('enabled'))
      else doc.setIn(at('enabled'), false)
    }

    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }

  /**
   * 在某个节点之后插入一个新节点。
   *
   * 插入而不是追加：**新节点接管 after 原来的出路**，于是「在 read 和 notify 之间加一步」
   * 只需要说一次位置，不用再去连两条线。
   *
   * 用的是 YAML 节点级操作（`YAMLSeq.items.splice`），所以文件里别的节点的注释、锚点、
   * 键序都不受影响——只动这一段落。
   * @param input - 接在谁后面、放什么类型、初始配置。
   * @returns 成功与新节点 id，或为什么没插成。
   */
  async addFlowNode(input: {
    readonly after?: string
    readonly type: string
    readonly config?: Readonly<Record<string, unknown>>
  }): Promise<TaskEdit & { readonly nodeId?: string }> {
    if (!this.nodes.has(input.type)) return { ok: false, message: `不认识的节点类型「${input.type}」` }
    const loaded = this.loadFlowDoc()
    if (!loaded.ok) return loaded
    const { doc, flowIndex, nodes } = loaded

    // `items` 里是 YAML 的节点对象，属性读不到——定位一律走 `toJS()` 出来的普通对象。
    const plain = doc.toJS() as { flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[] }
    const plainNodes = plain.flows?.[flowIndex]?.nodes ?? []
    const items = nodes.items as unknown[]
    const afterIndex = input.after === undefined
      ? items.length - 1
      : plainNodes.findIndex(item => item.id === input.after)
    if (input.after !== undefined && afterIndex < 0) {
      return { ok: false, message: `找不到节点「${input.after}」` }
    }

    const nodeId = this.freeNodeId(doc, flowIndex, input.type)
    // 新节点继承 after 原来的出路；after 随后只指向新节点。
    const inherited = input.after === undefined ? [] : (plainNodes[afterIndex]?.out ?? [])
    const spec: Record<string, unknown> = {
      id: nodeId,
      type: input.type,
      ...(input.config === undefined || Object.keys(input.config).length === 0 ? {} : { config: input.config }),
      ...(inherited.length === 0 ? {} : { out: inherited }),
    }
    items.splice(afterIndex + 1, 0, spec)
    if (input.after !== undefined) {
      doc.setIn(['flows', flowIndex, 'nodes', afterIndex, 'out'], [{ to: nodeId }])
    }

    await writeTextFile(this.rulesPath, doc.toString())
    await this.reloadRules()
    return { ok: true, nodeId }
  }

  /**
   * 删掉一个节点，并把它的入边接到它的出边——删掉一步不该让流程断在这里。
   * @param nodeId - 要删的节点。
   * @returns 成功，或为什么没删成。
   */
  async removeFlowNode(nodeId: string): Promise<TaskEdit> {
    const loaded = this.loadFlowDoc(nodeId)
    if (!loaded.ok) return loaded
    const { doc, flowIndex, nodes } = loaded

    const plain = doc.toJS() as { flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[] }
    const plainNodes = plain.flows?.[flowIndex]?.nodes ?? []
    const items = nodes.items as unknown[]
    const index = plainNodes.findIndex(item => item.id === nodeId)
    if (index < 0) return { ok: false, message: `找不到节点「${nodeId}」` }
    const leaving = plainNodes[index]?.out ?? []
    const leavingTarget = leaving.length === 1 ? leaving[0]?.['to'] : undefined

    // 指向它的边改接它的下一个；它分叉过（出边不止一条）就不猜，直接断开。
    for (const [other, item] of plainNodes.entries()) {
      if (other === index) continue
      const edges = item.out ?? []
      if (!edges.some(edge => edge['to'] === nodeId)) continue
      const repaired = edges.flatMap(edge => {
        if (edge['to'] !== nodeId) return [edge]
        return typeof leavingTarget === 'string' ? [{ ...edge, to: leavingTarget }] : []
      })
      doc.setIn(['flows', flowIndex, 'nodes', other, 'out'], repaired)
    }
    items.splice(index, 1)

    await writeTextFile(this.rulesPath, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }

  /**
   * 改一条出边指向谁。
   *
   * 比在画布上拖端口可靠：**按序号定位**，不依赖坐标；`to` 省略表示删掉这条边
   * （分支少一个出口）。条件跟着边走，不会因为换了目标就丢。
   * @param input - 从哪个节点的第几条边，改到哪。
   * @returns 成功，或为什么没改成。
   */
  async relinkFlowEdge(input: {
    readonly from: string
    readonly index: number
    readonly to?: string
  }): Promise<TaskEdit> {
    const loaded = this.loadFlowDoc(input.from)
    if (!loaded.ok) return loaded
    const { doc, flowIndex } = loaded

    const plain = doc.toJS() as { flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[] }
    const plainNodes = plain.flows?.[flowIndex]?.nodes ?? []
    const fromIndex = plainNodes.findIndex(item => item.id === input.from)
    if (fromIndex < 0) return { ok: false, message: `找不到节点「${input.from}」` }
    const edges = [...(plainNodes[fromIndex]?.out ?? [])]
    if (input.index < 0 || input.index >= edges.length) {
      return { ok: false, message: `「${input.from}」没有第 ${String(input.index + 1)} 条出边` }
    }
    if (input.to !== undefined && !plainNodes.some(item => item.id === input.to)) {
      return { ok: false, message: `找不到目标节点「${input.to}」` }
    }

    if (input.to === undefined) edges.splice(input.index, 1)
    else edges[input.index] = { ...edges[input.index], to: input.to }

    doc.setIn(['flows', flowIndex, 'nodes', fromIndex, 'out'], edges)
    await writeTextFile(this.rulesPath, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }

  /** 找出一个节点属于哪张图、那张图在哪个文件。 */
  /**
   * 找出一个节点属于哪张图、那张图在哪个文件。
   *
   * **优先用 `flowId`**：`trigger` / `branch` 这类 id 每张图里都有，只按节点 id 找会
   * 落到第一张图上，于是拖 A 图的节点写进了 B 图的文件。
   * @param nodeId - 节点 id；不给表示随便一张。
   * @param flowId - 图 id，给了就只在这张图里找。
   */
  private locateFlow(
    nodeId: string | undefined,
    flowId?: string,
  ): { readonly flow: Flow; readonly path: string } | undefined {
    for (const flow of this.currentFlows) {
      if (flowId !== undefined && flow.id !== flowId) continue
      const path = this.flowFiles.get(flow.id)
      if (path === undefined) continue
      if (nodeId === undefined || flow.nodes.some(node => node.id === nodeId)) return { flow, path }
    }
    return undefined
  }

  /**
   * 读文件并定位图的节点序列。
   *
   * 两种形状都认：
   * - **一规则一文件**：顶层直接是图，`nodes` 在根上（`flowIndex = -1`）
   * - 合集文件：`flows[0].nodes`（`flowIndex = 0`）
   * @param nodeId - 这个节点属于哪张图；不给时取第一张。
   */
  private loadFlowDoc(nodeId?: string): {
    readonly ok: true
    readonly doc: YamlDoc
    readonly flowIndex: number
    readonly nodes: YamlSeq
  } | { readonly ok: false; readonly message: string } {
    const located = this.locateFlow(nodeId)
    const path = located?.path ?? this.rulesPath
    let raw = ''
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return { ok: false, message: `读不到规则文件：${path}` }
    }
    if (raw === '') return { ok: false, message: `读不到规则文件：${path}` }

    let doc: YamlDoc
    try {
      doc = parseYaml(raw) as YamlDoc
    } catch (error: unknown) {
      return { ok: false, message: `规则文件读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: `规则文件有语法错误，先修好它：${doc.errors[0]?.message ?? ''}` }
    }

    /** 单图文件：`nodes` 在根上。 */
    const rootNodes = doc.getIn(['nodes']) as YamlSeq | undefined
    if (rootNodes !== undefined && Array.isArray(rootNodes.items)) {
      return { ok: true, doc, flowIndex: -1, nodes: rootNodes }
    }

    const flows = doc.getIn(['flows']) as YamlSeq | undefined
    if (flows === undefined || !Array.isArray(flows.items) || flows.items.length === 0) {
      return { ok: false, message: '这份规则文件里没有流程图' }
    }
    const nodes = doc.getIn(['flows', 0, 'nodes']) as YamlSeq | undefined
    if (nodes === undefined || !Array.isArray(nodes.items)) {
      return { ok: false, message: '第一张流程图没有节点列表' }
    }
    return { ok: true, doc, flowIndex: 0, nodes }
  }

  /** 造一个这张图里没被占用的节点 id。 */
  private freeNodeId(doc: YamlDoc, flowIndex: number, type: string): string {
    const data = doc.toJS() as { flows?: { nodes?: { id?: string }[] }[] }
    const taken = new Set((data.flows?.[flowIndex]?.nodes ?? []).map(node => node.id))
    const base = type.replace(/[^a-zA-Z0-9_-]/g, '-')
    for (let index = 0; index < 1000; index += 1) {
      const candidate = `${base}__${String(index)}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base}__${String(Date.now())}`
  }

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

  /** 一句告警。 */
  private warn(line: string): void {
    this.options.warn?.(line)
  }
}

/** yaml 的文档对象，只取这里用到的形状。 */
type YamlDoc = {
  readonly errors: readonly { readonly message?: string }[]
  getIn: (path: (string | number)[]) => unknown
  setIn: (path: (string | number)[], value: unknown) => unknown
  toJS: () => unknown
  toString: () => string
}

/** yaml 的序列节点。 */
type YamlSeq = { readonly items: readonly unknown[] }


/**
 * 在文件的图里找一处节点。
 *
 * 用读出来的普通对象定位，再用 setIn 按索引改——直接操作 AST 太脆，而索引就够了：
 * 同一次编辑里索引不会变。
 * @param doc - 已解析的规则文件。
 * @param nodeId - 要找的节点 id。
 * @returns 它在哪个 flow 的第几个 node；找不到是 undefined。
 */
/**
 * 在文件里定位一个节点。
 *
 * 两种形状都认：单图文件（根的 `nodes`，`flowIndex = -1`）与合集文件（`flows[i].nodes`）。
 * @param doc - 解析后的 YAML 文档。
 * @param nodeId - 要找的节点 id。
 * @returns 图序号与节点序号；找不到为 undefined。
 */
function locateNode(
  doc: { toJS: () => unknown },
  nodeId: string,
): { flowIndex: number; nodeIndex: number } | undefined {
  const data = doc.toJS()
  if (!isRecord(data)) return undefined

  /** 单图文件：节点直接在根上。 */
  if (Array.isArray(data['nodes'])) {
    for (const [nodeIndex, node] of data['nodes'].entries()) {
      if (isRecord(node) && node['id'] === nodeId) return { flowIndex: -1, nodeIndex }
    }
    return undefined
  }

  if (!Array.isArray(data['flows'])) return undefined
  for (const [flowIndex, flow] of data['flows'].entries()) {
    if (!isRecord(flow) || !Array.isArray(flow['nodes'])) continue
    for (const [nodeIndex, node] of flow['nodes'].entries()) {
      if (isRecord(node) && node['id'] === nodeId) return { flowIndex, nodeIndex }
    }
  }
  return undefined
}

/** 一个抛出物作为一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
