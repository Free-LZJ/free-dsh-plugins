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

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { parseDocument as parseYaml } from 'yaml'
import type { DecisionConfigBase, RuleVocabulary } from '../config.ts'
import { DEFAULT_DECISION_CONFIG, isRecord } from '../config.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import {
  loadRuleFile, setConditionValues, setRuleEnabled, swapPriority, type EditResult,
} from '../rules.ts'
import type { Rule, RuleFileError } from '../types.ts'

import { readJson, writeTextFile } from '../store.ts'
import { NODE_SIZE, resolvePositions, type LayoutAlign, type LayoutDirection, type LayoutStrategy } from '../flow/layout.ts'
import type { TaskConnector, TaskTestAnswer, TaskTestRef } from './connector.ts'
import type { EmitAck, TaskEvent } from './event.ts'
import type { ActionNode } from './node.ts'
import type { NodePatch, Task, TaskConnectorInfo, TaskState } from './record.ts'
import { OwnedRegistry, RegistrationConflict, TriggerRegistry } from './registry.ts'
import { TaskRunner, type ResumeInput, type UndoResult } from './runner.ts'
import { createTaskStore, forwardingStore, openTaskStore, type TaskStore } from './store.ts'
import { createDeferredStore, type DeferredStore } from './deferred.ts'
import { actionsToFlowNodes } from '../flow/adapt.ts'
import { createControlNodes } from '../flow/control.ts'
import { checkFlow, describeIssues } from '../flow/check.ts'
import { parseFlowDocument, parseFlowFile } from '../flow/parse.ts'
import { stringifyFlowDocument } from '../flow/serialize.ts'
import { FlowNodeRegistry } from '../flow/registry.ts'
import type { Flow, FlowParamSpec, NodeInputs, NodeOutputDecl } from '../flow/types.ts'
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

/** 补端点时读出来的节点形状：只关心 id / 类型 / 出边 / 坐标。 */
interface ScaffoldNode {
  readonly id?: string
  readonly type?: string
  readonly out?: readonly { readonly to?: string }[]
  readonly pos?: { readonly x?: number; readonly y?: number }
}

/** 每张图共有的入口节点；聚焦某条规则时它们一起保留。 */
const SHARED_FLOW_NODES = new Set(['start', 'classify', 'route', 'rest'])

/** 新节点与它的上游之间留一行（和自动布局的分层间距同一量级）。 */
const NEW_NODE_ROW_STEP = NODE_SIZE.height + 96

/** 让位时两列之间留的空。 */
const NEW_NODE_MARGIN = 64

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
  /**
   * 读事件规则：`events/<事件>/ *.yml`，顶层直接放 `.yml` 也认。
   *
   * 每个文件是**一条规则**（`when` + `nodes`），不是一张大图——一条规则一张图，
   * 图里不会混进别的规则的节点。
   * @param vocabulary - 合并后的词表。
   * @returns 全部规则图与「图 id → 文件路径」。
   */
  private readEventRules(vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>): {
    readonly flows: readonly Flow[]
    readonly files: ReadonlyMap<string, string>
  } {
    if (!existsSync(this.eventsDir)) return { flows: [], files: new Map() }

    const flows: Flow[] = []
    const files = new Map<string, string>()

    /** 先收顶层文件，再按目录名顺序收子目录，保证结果是确定的。 */
    const targets: string[] = [this.eventsDir]
    try {
      for (const entry of readdirSync(this.eventsDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) targets.push(join(this.eventsDir, entry.name))
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.warn('任务引擎: 读不了事件目录 ' + this.eventsDir + '（' + detail + '）')
      return { flows: [], files: new Map() }
    }

    for (const dir of targets) {
      const part = this.readDirFlows(dir, vocabulary)
      for (const flow of part.flows) {
        if (files.has(flow.id)) {
          this.warn('任务引擎: 规则 id「' + flow.id + '」重复，后一个被跳过')
          continue
        }
        flows.push(flow)
        const path = part.files.get(flow.id)
        if (path !== undefined) files.set(flow.id, path)
      }
    }
    return { flows, files }
  }

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

  /**
   * 重跑一条失败的任务。
   *
   * 不是「接着跑」：上一轮已经收场了，这里是用同一个事件**再开一轮**——换新的
   * `runId`、丢掉上一轮进度，节点记录按 `runId` 分组，历史那一轮不被覆盖。
   * 代价是已经成功的动作会再做一次（再标一次已读、再搬一次文件），所以页面上
   * 只在真的失败时才给这个按钮，并且按失败性质提示人先改配置。
   * @param taskId - 任务 id。
   * @returns 跑完了没有；没跑的原因写在 message 里。
   */
  async retry(taskId: string): Promise<TaskEdit> {
    const task = this.store.get(taskId)
    if (task === undefined) return { ok: false, message: `找不到任务 ${taskId}` }
    if (task.status !== 'partial' && task.status !== 'failed') {
      return { ok: false, message: '这条没有失败，不用重试' }
    }
    await this.runner.runChain(taskId)
    this.bump()
    return { ok: true }
  }

  /** 执行一条排队项（建议被批准时用）。 */
  async applyDeferred(deferredId: string): Promise<UndoResult> {
    return await this.runner.applyDeferred(deferredId)
  }

  /** 执行到期的延迟动作，并看一遍挂起的任务有没有等到东西。 */
  async runDue(now: Date = this.options.now?.() ?? new Date()): Promise<number> {
    return await this.runner.runDue(now)
  }

  /**
   * 唤醒一条挂起的任务。
   *
   * 挂起 = 这条链停在一格等信号（会话干完、人工确认、定时到点）。谁来唤醒不重要，
   * 重要的是令牌对得上：`ResumeInput.token` 与任务记下的那个不一致就拒绝。
   * @param input - 按任务或令牌找人，可带唤醒载荷。
   * @returns 结果与一句说明。
   */
  async resume(input: ResumeInput): Promise<UndoResult> {
    const result = await this.runner.resume(input)
    if (result.ok) this.bump()
    return result
  }

  /**
   * 往一条任务上补一格。
   *
   * 给「会话是工具直接建出来的」那条路径用：会话仍然是某条流程里的一格，只是这一格
   * 不是规则动作建的。**没有归属任务时不该调它**——那说明这次会话不属于任何流程，
   * 给它凭空造一条任务就会长出看板上那些莫名其妙红点。
   * @param taskId - 归属任务。
   * @param node - 这一格的内容。
   * @returns 写进去了没有。
   */
  async appendNode(taskId: string, node: {
    readonly kind: string
    readonly detail: string
    readonly sessionId?: string
    readonly ok?: boolean
    readonly data?: Readonly<Record<string, unknown>>
  }): Promise<boolean> {
    const task = this.store.get(taskId)
    if (task === undefined) return false
    await this.store.appendNode(taskId, {
      id: `node-${randomUUID()}`,
      kind: node.kind,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      ok: node.ok ?? true,
      detail: node.detail,
      ...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
      ...(node.data === undefined ? {} : { data: node.data }),
    })
    this.bump()
    return true
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

  /**
   * 拿一条真实事件试跑；引擎不认识事件，所以由连接器回答。
   *
   * **图模式要换一套喂法**：那时 `currentRules` 是空的（规则写在图里），直接把空数组
   * 交给连接器，它只能回答「没有规则命中——这封邮件会被留在面板里」，而实际上这封邮件
   * 明明会被流程图分走。所以这里把图里的**分支边**翻成一组临时规则（每条边就是一条
   * 「凭什么走这条路」），连接器照旧逐条判——试跑的答案就变成「会走哪条边、其它边为什么
   * 没走」，而不是一句假话。
   *
   * 只判不走：`then` 留空，试跑不执行任何动作。
   */
  async test(ref: TaskTestRef): Promise<TaskTestAnswer> {
    for (const connector of this.connectors.values()) {
      if (connector.test === undefined) continue
      const flow = this.flowFor(connector.id)
      const rules = flow === undefined ? this.currentRules : this.edgesAsRules(flow)
      return await connector.test(ref, rules)
    }
    return { ok: false, message: '还没有连接器能试跑事件' }
  }

  /**
   * 这个连接器的事件流是哪张图。
   *
   * 试跑只对「事件流」有意义：子工作流没有自己的事件，它由事件流调用。没有专属的
   * 就用 `connector: '*'` 的兜底图——和真正派活时的顺序一致。
   * @param connectorId - 连接器 id。
   * @returns 图，或 undefined（这份规则里没有它的事件流）。
   */
  private flowFor(connectorId: string): Flow | undefined {
    const flows = [...this.eventFlows.values()]
    return flows.find(flow => flow.connector === connectorId)
      ?? flows.find(flow => flow.connector === '*')
  }

  /**
   * 把一张图里的分支边翻成一组「临时规则」，给试跑用。
   *
   * 只有带 `switch` 的图才有「走哪条」这回事；没有分支的图让连接器按空规则表回答
   * （它会给「没有规则命中」，那时是实话——这张图不看条件）。
   * @param flow - 要试跑的图。
   * @returns 每条出边一条规则，顺序就是图里的顺序。
   */
  private edgesAsRules(flow: Flow): readonly Rule<ConditionSpecLike, ActionSpecLike>[] {
    const rules: Rule<ConditionSpecLike, ActionSpecLike>[] = []
    for (const node of flow.nodes) {
      if (node.type !== 'switch' || node.out === undefined) continue
      node.out.forEach((edge, index) => {
        rules.push({
          id: `${node.id}->${edge.to}#${String(index)}`,
          name: `${node.label ?? node.id} → ${flow.nodes.find(item => item.id === edge.to)?.label ?? edge.to}`,
          enabled: true,
          priority: index * 10,
          connector: flow.connector,
          when: (edge.when ?? []) as readonly ConditionSpecLike[],
          // 试跑不执行动作：这一栏空着，比塞一条假的更有用。
          then: [],
        })
      })
    }
    return rules
  }

  /* ─────────────────────────────── 内部 ─────────────────────────────── */

  /** 重新读规则；成功才替换当前生效的那一份。 */
  private async reloadRules(): Promise<void> {
    const vocabulary = this.combinedVocabulary()
    if (vocabulary === undefined) return

    // 子工作流与事件流：新结构。先读子工作流，事件流里的 workflow 节点要按 id 引用它。
    const wfDir = this.readDirFlows(this.workflowsDir, vocabulary)
    this.workflows = new Map(wfDir.flows.map(flow => [flow.id, flow]))

    // `events/` 下每个子目录是一个事件的规则集（`events/mail-new/*.yml`）；
    // 顶层直接放 `.yml` 也认，方便手写单文件试试。
    const evDir = this.readEventRules(vocabulary)
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
      // 子工作流的文件也要在里面：否则保存它们的节点时会去 rules.yml 找，报「找不到节点」。
      this.flowFiles = new Map([...evDir.files, ...wfDir.files])
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
    /**
     * 监听**整个规则目录**，不只是 `rules.yml`。
     *
     * 规则早就不只在那一个文件里了（`flows/`、`events/`、`workflows/` 下都是一张张
     * 独立的 yml），只盯 `rules.yml` 的话，改图之后引擎内存里还是旧的——界面上看着
     * 「改了没反应」，直到重启。
     */
    const dir = dirname(this.rulesPath)
    try {
      this.watcher = watch(dir, { persistent: false, recursive: true }, (_event, name) => {
        // 目录里还有 tasks.db / runs.json，它们写得比规则勤，别让它们触发重载。
        const file = typeof name === 'string' ? name : ''
        if (file !== '' && !/\.ya?ml$/i.test(file)) return
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
    /** 入参表；给空对象表示清空。 */
    readonly inputs?: NodeInputs
    /** 出参表；给空对象表示清空。 */
    readonly outputs?: Readonly<Record<string, NodeOutputDecl>>
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
    if (input.inputs !== undefined) {
      if (Object.keys(input.inputs).length === 0) doc.deleteIn(at('inputs'))
      else doc.setIn(at('inputs'), input.inputs)
    }
    if (input.outputs !== undefined) {
      if (Object.keys(input.outputs).length === 0) doc.deleteIn(at('outputs'))
      else doc.setIn(at('outputs'), input.outputs)
    }
    if (input.pos !== undefined) doc.setIn(at('pos'), { x: input.pos.x, y: input.pos.y })
    // 空串 = 清掉自定义名，回到自动名（节点类型中文名 / 被调工作流名）。
    if (input.label !== undefined) {
      if (input.label.trim() === '') doc.deleteIn(at('label'))
      else doc.setIn(at('label'), input.label.trim())
    }
    if (input.enabled !== undefined) {
      // 启用时不写 `enabled: true`——文件里只该出现「关掉了」这个例外。
      if (input.enabled) doc.deleteIn(at('enabled'))
      else doc.setIn(at('enabled'), false)
    }

    // 保存前把「改完的这张图」完整解析一遍：声明对不上就不落盘，别让坏图进文件。
    const text = doc.toString()
    const checked = this.checkFlowText(text, input.flowId ?? located?.flow.id)
    if (!checked.ok) return { ok: false, message: checked.message }

    await writeTextFile(path, text)
    await this.reloadRules()
    return { ok: true }
  }

  /**
   * 保存流程级常量 / 入参声明。
   *
   * 与 `saveFlowNode` 同一套校验：`flow.params` 是 `flow.<name>` 引用的唯一来源，写错
   * 等于让整张图的引用悬空，所以不通过就不落盘。
   * @param input - 哪张图、常量列表（空数组表示清空）。
   * @returns 成功，或为什么没改成。
   */
  async saveFlowParams(input: {
    readonly flowId: string
    readonly params: readonly FlowParamSpec[]
  }): Promise<TaskEdit> {
    const located = this.locateFlow(undefined, input.flowId)
    if (located === undefined) return { ok: false, message: `没有这张图：${input.flowId}` }
    let raw = ''
    try { raw = readFileSync(located.path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: `读不到规则文件：${located.path}` }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: `规则文件读不出来：${error instanceof Error ? error.message : String(error)}` }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: `规则文件有语法错误，先修好它：${doc.errors[0]?.message ?? ''}` }
    }
    // 一图一文件时 params 在根上；合集文件时在 flows[i] 上。
    const flowIndex = locateFlowIndex(doc, input.flowId)
    const at = flowIndex < 0 ? ['params'] : ['flows', flowIndex, 'params']
    if (input.params.length === 0) doc.deleteIn(at)
    else doc.setIn(at, input.params.map(param => ({
      name: param.name,
      ...(param.label === undefined ? {} : { label: param.label }),
      ...(param.required === true ? { required: true } : {}),
      ...(param.default === undefined ? {} : { default: param.default }),
    })))

    const text = doc.toString()
    const checked = this.checkFlowText(text, input.flowId)
    if (!checked.ok) return { ok: false, message: checked.message }
    await writeTextFile(located.path, text)
    await this.reloadRules()
    return { ok: true }
  }

  /**
   * 保存前的声明校验。
   *
   * 词表没接上时（引擎还没 mount 任何连接器）跳过：那时条件会被解析成「丢掉」，
   * 校验会报一堆假问题。
   */
  private checkFlowText(text: string, flowId: string | undefined): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const vocabulary = this.combinedVocabulary()
    if (vocabulary === undefined) return { ok: true }
    // 两种文件形状都要认：一图一文件（顶层就是图），以及还没迁完的合集（flows 数组）。
    const single = parseFlowDocument(text, this.nodes, vocabulary)
    let flow = single.flow
    if (flow === undefined) {
      const many = parseFlowFile(text, this.nodes, vocabulary)
      flow = flowId === undefined ? many.flows[0] : many.flows.find(item => item.id === flowId)
      if (flow === undefined) {
        return {
          ok: false,
          message: `改完之后这张图读不出来：${many.error?.message ?? single.error?.message ?? single.dropped.join('；')}`,
        }
      }
    }
    if (flowId !== undefined && flow.id !== flowId) return { ok: true }
    const result = checkFlow(flow, this.nodes)
    if (result.ok) return { ok: true }
    return { ok: false, message: `保存前检查没过：${describeIssues(result.issues)}` }
  }

  /**
   * 重新自动布局一张图，并把位置写回文件。
   *
   * 一次读写：所有节点的 `pos` 改完才落盘，不是每个节点各写一次——否则一张 22 节点
   * 的图会触发 22 次写入和 22 次重载。
   *
   * `keepManual` 传 `false`：自动布局保留人手摆的位置就等于点了没反应。
   * @param input - 哪张图、什么方向、什么策略。
   * @returns 成功或为什么没排成。
   */
  async autoLayout(input: {
    readonly flowId: string
    readonly direction?: LayoutDirection
    readonly strategy?: LayoutStrategy
    readonly align?: LayoutAlign
  }): Promise<TaskEdit & { readonly positions?: readonly { readonly id: string; readonly x: number; readonly y: number }[] }> {
    const located = this.locateFlow(undefined, input.flowId)
    if (located === undefined) return { ok: false, message: '没有这张图：' + input.flowId }

    const positions = resolvePositions(located.flow, {
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      ...(input.align === undefined ? {} : { align: input.align }),
      keepManual: false,
    })

    let raw = ''
    try { raw = readFileSync(located.path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: '读不到规则文件：' + located.path }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: '规则文件读不出来：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: '规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    }

    let moved = 0
    for (const [nodeId, pos] of positions) {
      const found = locateNode(doc, nodeId)
      if (found === undefined) continue
      const at = found.flowIndex < 0
        ? ['nodes', found.nodeIndex, 'pos']
        : ['flows', found.flowIndex, 'nodes', found.nodeIndex, 'pos']
      doc.setIn(at, { x: Math.round(pos.x), y: Math.round(pos.y) })
      moved += 1
    }
    if (moved === 0) return { ok: false, message: '这张图里没有可排的节点' }

    await writeTextFile(located.path, doc.toString())
    await this.reloadRules()
    // 坐标回传一份：文件写对了、画布却没换位置的时候（实测撞到过），前端可以直接
    // 把这份画上去，不必等下一次整图重读。
    return {
      ok: true,
      positions: [...positions].map(([id, pos]) => ({ id, x: Math.round(pos.x), y: Math.round(pos.y) })),
    }
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
    /** 这个节点加进哪张图；`after` 的 id 可能每张图都有，缺了就写错文件。 */
    readonly flowId?: string
    readonly config?: Readonly<Record<string, unknown>>
  }): Promise<TaskEdit & { readonly nodeId?: string }> {
    if (!this.nodes.has(input.type)) return { ok: false, message: `不认识的节点类型「${input.type}」` }
    const loaded = this.loadFlowDoc(input.after, input.flowId)
    if (!loaded.ok) return loaded
    const { doc, flowIndex, nodes, path } = loaded

    // `items` 里是 YAML 的节点对象，属性读不到——定位一律走 `toJS()` 出来的普通对象。
    // 两种形状都要认：一图一文件时 `nodes` 在根上，合集文件时在 `flows[i].nodes`。
    const plain = doc.toJS() as {
      nodes?: { id?: string; type?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; type?: string; out?: Record<string, unknown>[] }[] }[]
    }
    const plainNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
    const items = nodes.items as unknown[]

    /**
     * 接在谁后面。
     *
     * 没指定就先看「末尾」认不认得清——认不清就别猜：凭空追加一个没有任何入边的
     * 节点，界面上说「加好了」，流程里却是一座永远跑不到的孤岛。
     */
    const anchor: { readonly ok: true; readonly after?: string } | { readonly ok: false; readonly message: string } =
      input.after === undefined ? this.tailAnchorOf(plainNodes) : { ok: true, after: input.after }
    if (anchor.ok === false) return anchor
    const after = anchor.after
    const afterIndex = after === undefined
      ? items.length - 1
      : plainNodes.findIndex(item => item.id === after)
    if (after !== undefined && afterIndex < 0) {
      return { ok: false, message: `找不到节点「${after}」` }
    }

    const nodeId = this.freeNodeId(doc, flowIndex, input.type)
    // 新节点继承 after 原来的出路；after 随后只指向新节点。
    const inherited = after === undefined ? [] : (plainNodes[afterIndex]?.out ?? [])
    const spec: Record<string, unknown> = {
      id: nodeId,
      type: input.type,
      // 坐标必须一起写：不写就落在 (0,0)，压在第一个节点身上，看着像「点了没反应」。
      pos: this.placeNewNode(plainNodes, after),
      ...(input.config === undefined || Object.keys(input.config).length === 0 ? {} : { config: input.config }),
      ...(inherited.length === 0 ? {} : { out: inherited }),
    }
    items.splice(afterIndex + 1, 0, spec)
    if (after !== undefined) {
      // 两种形状的路径不一样：一图一文件时节点在根上，没有 `flows` 这一层。
      const outAt = flowIndex < 0
        ? ['nodes', afterIndex, 'out']
        : ['flows', flowIndex, 'nodes', afterIndex, 'out']
      doc.setIn(outAt, [{ to: nodeId }])
    }

    // **写回它所在的那个文件**。写死 `rules.yml` 的话，一图一文件模式下新节点会落进
    // 一份没人读的文件里，同时把真正的 rules.yml 覆盖成这张图的内容。
    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true, nodeId }
  }

  /**
   * 新节点摆在哪。
   *
   * 不写坐标的话它落在 `(0, 0)`：卡片的左上角正好压在图上第一个节点身上，看起来像
   * 「点了没反应」——加了好几个就叠成一摞。这里给它一个说得通的位置：接在谁后面就摆到
   * 它下方一层；那块地方有人了就往右让一个车位，直到不压着别人。
   * @param nodes - 这张图现有的节点（普通对象形式，坐标可能没有）。
   * @param after - 新节点接在谁后面；没有就摆到整张图的下方。
   * @returns 写进文件的坐标。
   */
  private placeNewNode(
    nodes: readonly { readonly id?: string; readonly pos?: { readonly x?: number; readonly y?: number } }[],
    after: string | undefined,
  ): { x: number; y: number } {
    const boxes = nodes.map(node => ({ x: Number(node.pos?.x ?? 0), y: Number(node.pos?.y ?? 0) }))
    const anchor = after === undefined ? undefined : nodes.find(node => node.id === after)
    const start = anchor === undefined
      ? { x: 0, y: boxes.reduce((bottom, box) => Math.max(bottom, box.y), 0) + NEW_NODE_ROW_STEP }
      : { x: Number(anchor.pos?.x ?? 0), y: Number(anchor.pos?.y ?? 0) + NEW_NODE_ROW_STEP }

    // 与已有卡片重叠（留一点余量）就往右挪一列：人看得到它在哪，也不会压在别人身上。
    const clashes = (box: { readonly x: number; readonly y: number }): boolean => boxes.some(other =>
      Math.abs(other.x - box.x) < NODE_SIZE.width + NEW_NODE_MARGIN
      && Math.abs(other.y - box.y) < NODE_SIZE.height + NEW_NODE_MARGIN)
    let place = start
    for (let step = 0; step < 64 && clashes(place); step += 1) {
      place = { x: place.x + NODE_SIZE.width + NEW_NODE_MARGIN, y: place.y }
    }
    return { x: Math.round(place.x), y: Math.round(place.y) }
  }

  /**
   * 没指定「接在谁后面」时，猜一个末尾——**只有认得清才猜**。
   *
   * - 有 `end` 节点：末尾就是那些直接连到 `end` 的节点
   * - 没有 `end`：末尾是没有出边的节点
   *
   * 恰好一个才算认得清；一个都没有（空图）就直接追加；多于一个就闭嘴，让界面去问人。
   * @param nodes - 这张图的节点（普通对象形式）。
   * @returns 接在谁后面，或为什么不能猜。
   */
  private tailAnchorOf(
    nodes: readonly { readonly id?: string; readonly type?: string; readonly out?: readonly Record<string, unknown>[] }[],
  ): { readonly ok: true; readonly after?: string } | { readonly ok: false; readonly message: string } {
    const end = nodes.find(item => item.type === 'end')
    const tails = end === undefined
      ? nodes.filter(item => (item.out ?? []).length === 0)
      : nodes.filter(item => item.id !== end.id && (item.out ?? []).some(edge => edge['to'] === end.id))
    if (tails.length === 0) return { ok: true }
    if (tails.length > 1) {
      return {
        ok: false,
        message: `这张图有 ${String(tails.length)} 个地方直接连到「结束」，先在画布上选中要接在哪个节点后面，再新增`,
      }
    }
    const [only] = tails
    return only?.id === undefined ? { ok: true } : { ok: true, after: only.id }
  }

  /**
   * 给新流程挑一个 id：英文名转 slug，中文名退回 `前缀-1`、`前缀-2`。
   *
   * 以前对中文名用时间戳（`rule-1763867123456`），结果事件流上挂着一排
   * `call-rule-1763867123456` 的方块——看不出是什么，还长得一样。序号短、可预测、
   * 在画布上也读得出来。
   * @param prefix - 中文名时用的前缀。
   * @param ascii - 名字转出来的 slug；空串表示转不出来。
   * @returns 一个没被别人占用的 id。
   */
  private freeFlowId(prefix: string, ascii: string): string {
    if (ascii !== '') {
      let id = ascii
      for (let index = 2; this.workflows.has(id); index += 1) id = `${ascii}-${String(index)}`
      return id
    }
    let index = 1
    while (this.workflows.has(`${prefix}-${String(index)}`)) index += 1
    return `${prefix}-${String(index)}`
  }

  /**
   * 新建一张**独立**的子工作流（不挂到任何事件流上）。
   *
   * 「+ 新建规则」会顺手建一个子工作流，但那只发生在你想让某条规则命中时。
   * 想先把一段可复用的流程搭出来、之后再接事件，之前没有入口——只能先建一条规则
   * 再把它拆掉。这个入口就是补这个洞。
   *
   * @param input - 显示名与连接器；id 从名字转 slug，转不出来就退回时间戳。
   * @returns 建成了（带 id），或为什么没建成。
   */
  async addWorkflow(input: {
    readonly name: string
    readonly connector?: string
  }): Promise<TaskEdit & { readonly flowId?: string }> {
    const name = input.name.trim()
    if (name === '') return { ok: false, message: '工作流得有个名字' }
    const connector = (input.connector ?? '').trim() === '' ? '*' : (input.connector ?? '').trim()

    const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const flowId = this.freeFlowId('flow', ascii)

    const path = join(this.workflowsDir, flowId + '.yml')
    try {
      mkdirSync(this.workflowsDir, { recursive: true })
      writeFileSync(
        path,
        stringifyFlowDocument(
          {
            id: flowId,
            name,
            connector,
            nodes: [
              { id: 'start', type: 'start', out: [{ to: 'end' }] },
              { id: 'end', type: 'end' },
            ],
          },
          { header: '新建的子工作流：在「开始」和「结束」之间加它要做的事。' },
        ),
        'utf8',
      )
    } catch (error) {
      return { ok: false, message: '写不了工作流文件：' + (error instanceof Error ? error.message : String(error)) }
    }

    await this.reloadRules()
    return { ok: true, message: `已新建「${name}」`, flowId }
  }

  /**
   * 给一张图补上「开始 / 结束」两个端点（只补缺的那个）。
   *
   * 老图是「一串节点走到哪算哪」：入口是谁靠猜（没有入边的那个），出口干脆没有。补上
   * 之后入参出参才有地方声明，画布上也看得出图的边界。**只在人点按钮时执行**，不自动
   * 改写已有的规则文件。
   *
   * 连线按图的形状来：开始接到原来的入口（没有入边的节点），结束接住原来的末尾
   * （没有出边的节点）。已经有的那一个不重复添加。
   * @param flowId - 哪张子工作流。
   * @returns 成功，或为什么没补成。
   */
  async addFlowScaffold(flowId: string): Promise<TaskEdit> {
    const file = this.flowFiles.get(flowId)
    if (file === undefined) return { ok: false, message: `找不到工作流「${flowId}」` }
    const outcome = this.patchScaffold(file)
    if (!outcome.ok) return outcome
    await writeTextFile(file, outcome.text)
    await this.reloadRules()
    return { ok: true, message: outcome.message }
  }

  /**
   * 一次把所有缺端点的子工作流补齐（**逐张先备份再改**）。
   *
   * 为什么要有批量：11 张图只有事件流那种是从旧规则迁过来的，子工作流很多是「一个节点
   * 干一件事」，点进去看不出从哪进、到哪出。一张张点「补开始/结束」太啰嗦，而且容易忘。
   *
   * 每张要改的文件先写成 `<文件名>.bak-scaffold-<毫秒>`，改坏了能直接拷回来。
   * @returns 补了几张，以及哪几张没补成（有失败就整体 `ok: false`，但成功的照样落盘）。
   */
  async scaffoldFlows(): Promise<TaskEdit> {
    const flows = this.flowView().flows
    const missing = [...this.flowFiles.entries()].filter(([flowId]) => {
      const flow = flows.find((item) => item.id === flowId)
      if (flow === undefined) return false
      const hasStart = flow.nodes.some((node) => node.type === 'start')
      const hasEnd = flow.nodes.some((node) => node.type === 'end')
      return !hasStart || !hasEnd
    })
    if (missing.length === 0) return { ok: true, message: '没有缺端点的子工作流' }

    const done: string[] = []
    const failed: string[] = []
    for (const [flowId, file] of missing) {
      const outcome = this.patchScaffold(file)
      if (!outcome.ok) {
        failed.push(`${flowId}：${outcome.message}`)
        continue
      }
      try {
        copyFileSync(file, `${file}.bak-scaffold-${String(Date.now())}`)
      } catch (error) {
        // 备份写不出来就不改：宁可不补，也不留一个改坏了还没备份的文件。
        failed.push(`${flowId}：备份失败（${error instanceof Error ? error.message : String(error)}）`)
        continue
      }
      await writeTextFile(file, outcome.text)
      done.push(flowId)
    }
    if (done.length > 0) await this.reloadRules()
    if (failed.length > 0) {
      return { ok: false, message: `补了 ${String(done.length)} 张，${String(failed.length)} 张没补成：${failed.join('；')}` }
    }
    return { ok: true, message: `已补齐 ${String(done.length)} 张子工作流的开始/结束` }
  }

  /**
   * 算出「补端点」之后该写什么，不落盘。
   *
   * 拆出来是为了批量补齐能先备份、再统一 reload；单张调用直接写。
   * @param file - 工作流文件绝对路径。
   * @returns 新的文件内容，或为什么补不成。
   */
  private patchScaffold(file: string): { readonly ok: true; readonly text: string; readonly message: string } | TaskEdit & { readonly ok: false } {
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return { ok: false, message: '读不到工作流文件：' + file }
    }
    const doc = parseYaml(raw)
    if (doc.errors.length > 0) return { ok: false, message: '工作流文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    const flow = doc.toJS() as {
      nodes?: ScaffoldNode[]
      flows?: { nodes?: ScaffoldNode[] }[]
    }
    const flowIndex = (flow.nodes === undefined && (flow.flows?.length ?? 0) > 0) ? 0 : -1
    const nodes = flowIndex < 0 ? (flow.nodes ?? []) : (flow.flows?.[flowIndex]?.nodes ?? [])
    if (nodes.length === 0) return { ok: false, message: '这张图是空的，没有可补的端点' }

    const hasStart = nodes.some(node => node.type === 'start')
    const hasEnd = nodes.some(node => node.type === 'end')
    if (hasStart && hasEnd) return { ok: false, message: '这张图已经有开始和结束了' }

    const targets = new Set(nodes.flatMap(node => (node.out ?? []).map(edge => edge.to)))
    // 入口 = 没有入边的节点；末尾 = 没有出边的节点。
    const entries = nodes.filter(node => node.id !== undefined && !targets.has(node.id) && node.type !== 'end')
    const tails = nodes.filter(node => (node.out ?? []).length === 0 && node.type !== 'start')

    const items = (flowIndex < 0 ? (doc.getIn(['nodes']) as { items?: unknown[] }) : (doc.getIn(['flows', flowIndex, 'nodes']) as { items?: unknown[] }))
    if (items?.items === undefined) return { ok: false, message: '读不出节点表' }
    const list = items.items as unknown[]

    const added: string[] = []
    if (!hasStart) {
      const id = this.freeNodeId(doc, flowIndex, 'start')
      const above = entries[0]?.pos
      list.push({
        id,
        type: 'start',
        // 只在上游本来就有坐标时才自己写一个：整张图都没坐标的话，交给自动布局统一算，
        // 混着写会出现「两个端点自己排在 (0,0)」这种别扭的图。
        ...(above === undefined ? {} : { pos: { x: Number(above.x ?? 0), y: Math.max(0, Number(above.y ?? 0) - NEW_NODE_ROW_STEP) } }),
        ...(entries.length === 0 ? {} : { out: entries.map(node => ({ to: node.id })) }),
      })
      added.push('开始')
    }
    if (!hasEnd) {
      const id = this.freeNodeId(doc, flowIndex, 'end')
      const below = tails[0]?.pos
      list.push({
        id,
        type: 'end',
        ...(below === undefined ? {} : { pos: { x: Number(below.x ?? 0), y: Number(below.y ?? 0) + NEW_NODE_ROW_STEP } }),
      })
      // 末尾指向新的结束节点：原来没有出边的那些节点都接过来。
      for (const tail of tails) {
        if (tail.id === undefined) continue
        const at = flowIndex < 0 ? ['nodes'] : ['flows', flowIndex, 'nodes']
        const index = nodes.indexOf(tail)
        doc.setIn([...at, index, 'out'], [{ to: id }])
      }
      added.push('结束')
    }

    if (added.length === 0) return { ok: false, message: '这张图已经有开始和结束了' }
    return { ok: true, text: doc.toString(), message: `已补上：${added.join('、')}` }
  }

  /**
   * 删掉一个节点，并把它的入边接到它的出边——删掉一步不该让流程断在这里。
   * @param nodeId - 要删的节点。
   * @returns 成功，或为什么没删成。
   */
  async removeFlowNode(nodeId: string): Promise<TaskEdit> {
    const loaded = this.loadFlowDoc(nodeId)
    if (!loaded.ok) return loaded
    const { doc, flowIndex, nodes, path } = loaded

    const plain = doc.toJS() as {
      nodes?: { id?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[]
    }
    // 两种形状都要认，否则一图一文件模式下永远「找不到节点」，删都删不掉。
    const plainNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
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
      doc.setIn(
        flowIndex < 0 ? ['nodes', other, 'out'] : ['flows', flowIndex, 'nodes', other, 'out'],
        repaired,
      )
    }
    items.splice(index, 1)

    // **写回它所在的那个文件**（同 addFlowNode：不能写死 rules.yml）。
    await writeTextFile(path, doc.toString())
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
  /**
   * 改一条已有出边的指向，或删掉它。
   *
   * 和改节点一样：**写到那条边所在的那个文件**，不是 `rules.yml`。单图文件里节点在
   * 根上的 `nodes`，合集文件里在 `flows[i].nodes`，两种都要认。
   * @param input - 从哪个节点、第几条出边、改成谁（不给就是删）。
   * @returns 成功或为什么没改成。
   */
  async relinkFlowEdge(input: {
    readonly from: string
    readonly index: number
    readonly to?: string
    readonly flowId?: string
  }): Promise<TaskEdit> {
    const located = this.locateFlow(input.from, input.flowId)
    if (located === undefined) return { ok: false, message: `找不到节点「${input.from}」所属的图` }
    const path = located.path
    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: '读不到规则文件：' + path }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: '规则文件读不出来：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: '规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    }

    const found = locateNode(doc, input.from)
    if (found === undefined) return { ok: false, message: `文件里找不到节点「${input.from}」` }
    const { flowIndex, nodeIndex } = found
    const at = (key: string): (string | number)[] =>
      flowIndex < 0 ? ['nodes', nodeIndex, key] : ['flows', flowIndex, 'nodes', nodeIndex, key]

    const plain = doc.toJS() as {
      nodes?: { id?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[]
    }
    const allNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
    const edges = [...(allNodes[nodeIndex]?.out ?? [])]
    if (input.index < 0 || input.index >= edges.length) {
      return { ok: false, message: `「${input.from}」没有第 ${String(input.index + 1)} 条出边` }
    }
    if (input.to !== undefined && !allNodes.some(item => item.id === input.to)) {
      return { ok: false, message: `找不到目标节点「${input.to}」` }
    }

    if (input.to === undefined) edges.splice(input.index, 1)
    else edges[input.index] = { ...edges[input.index], to: input.to }

    doc.setIn(at('out'), edges)
    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }

  /**
   * 新增一条出边：从 `from` 接到 `to`，可以带条件。
   *
   * 这就是「新建规则」的最后一环——事件流里给 `分支` 加一条出边，指向一个子工作流。
   * 已经有同样指向的边时拒绝，免得手抖点两下多出一条重复的。
   * @param input - 从哪、到哪、条件是什么。
   * @returns 成功或为什么没加成。
   */
  async addFlowEdge(input: {
    readonly from: string
    readonly to: string
    readonly flowId?: string
    readonly when?: readonly Readonly<Record<string, unknown>>[]
    readonly mode?: 'fork'
  }): Promise<TaskEdit> {
    if (input.from === input.to) return { ok: false, message: '不能连到自己' }
    const located = this.locateFlow(input.from, input.flowId)
    if (located === undefined) return { ok: false, message: `找不到节点「${input.from}」所属的图` }
    const path = located.path

    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: '读不到规则文件：' + path }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: '规则文件读不出来：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: '规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    }

    const found = locateNode(doc, input.from)
    if (found === undefined) return { ok: false, message: `文件里找不到节点「${input.from}」` }
    const { flowIndex, nodeIndex } = found
    const at = (key: string): (string | number)[] =>
      flowIndex < 0 ? ['nodes', nodeIndex, key] : ['flows', flowIndex, 'nodes', nodeIndex, key]

    const plain = doc.toJS() as {
      nodes?: { id?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[]
    }
    const allNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
    if (!allNodes.some(item => item.id === input.to)) {
      return { ok: false, message: `找不到目标节点「${input.to}」` }
    }

    const edges = [...(allNodes[nodeIndex]?.out ?? [])]
    if (edges.some(edge => edge['to'] === input.to)) {
      return { ok: false, message: `「${input.from}」已经连到「${input.to}」了` }
    }

    edges.push({
      to: input.to,
      ...(input.when === undefined || input.when.length === 0 ? {} : { when: input.when }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })

    doc.setIn(at('out'), edges)
    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }
  /**
   * 把一条出边往上/往下挪一位。
   *
   * `分支`（switch）按**文件里的顺序**从上往下判定，第一个条件成立的边赢——所以顺序
   * 就是优先级，而以前这件事只能靠手改 YAML。兜底边（没有 `when`）永远成立，排在它
   * 后面的边一条都走不到，挪一下就能修好。
   * @param input - 从哪个节点、第几条出边、往哪个方向。
   * @returns 成功，或为什么没挪成。
   */
  async moveFlowEdge(input: {
    readonly from: string
    readonly index: number
    readonly direction: 'up' | 'down'
    readonly flowId?: string
  }): Promise<TaskEdit> {
    const located = this.locateFlow(input.from, input.flowId)
    if (located === undefined) return { ok: false, message: `找不到节点「${input.from}」所属的图` }
    const path = located.path
    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: '读不到规则文件：' + path }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: '规则文件读不出来：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: '规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    }

    const found = locateNode(doc, input.from)
    if (found === undefined) return { ok: false, message: `文件里找不到节点「${input.from}」` }
    const { flowIndex, nodeIndex } = found
    const at = (key: string): (string | number)[] =>
      flowIndex < 0 ? ['nodes', nodeIndex, key] : ['flows', flowIndex, 'nodes', nodeIndex, key]

    const plain = doc.toJS() as {
      nodes?: { id?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[]
    }
    const allNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
    const edges = [...(allNodes[nodeIndex]?.out ?? [])]
    if (input.index < 0 || input.index >= edges.length) {
      return { ok: false, message: `「${input.from}」没有第 ${String(input.index + 1)} 条出边` }
    }
    const target = input.direction === 'up' ? input.index - 1 : input.index + 1
    if (target < 0 || target >= edges.length) {
      return { ok: false, message: input.direction === 'up' ? '已经是第一条了' : '已经是最后一条了' }
    }
    const moved = edges[input.index]
    const displaced = edges[target]
    if (moved === undefined || displaced === undefined) return { ok: false, message: '这条出边读不出来' }
    edges[target] = moved
    edges[input.index] = displaced

    doc.setIn(at('out'), edges)
    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true, message: `已挪到第 ${String(target + 1)} 条` }
  }

  /**
   * 改一条边的条件。
   *
   * 条件是「这条规则凭什么被选中」，`when: []` 表示无条件（兜底，总是成立）。
   * 只动条件，不动指向——要改指向用 `relinkFlowEdge`。
   * @param input - 从哪个节点、第几条出边、新的条件。
   * @returns 成功或为什么没改成。
   */
  async saveFlowEdge(input: {
    readonly from: string
    readonly index: number
    readonly flowId?: string
    readonly when?: readonly Readonly<Record<string, unknown>>[]
  }): Promise<TaskEdit> {
    const located = this.locateFlow(input.from, input.flowId)
    if (located === undefined) return { ok: false, message: `找不到节点「${input.from}」所属的图` }
    const path = located.path

    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    if (raw === '') return { ok: false, message: '读不到规则文件：' + path }
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return { ok: false, message: '规则文件读不出来：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (doc.errors.length > 0) {
      return { ok: false, message: '规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? '') }
    }

    const found = locateNode(doc, input.from)
    if (found === undefined) return { ok: false, message: `文件里找不到节点「${input.from}」` }
    const { flowIndex, nodeIndex } = found
    const at = (key: string): (string | number)[] =>
      flowIndex < 0 ? ['nodes', nodeIndex, key] : ['flows', flowIndex, 'nodes', nodeIndex, key]

    const plain = doc.toJS() as {
      nodes?: { id?: string; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; out?: Record<string, unknown>[] }[] }[]
    }
    const allNodes = flowIndex < 0 ? (plain.nodes ?? []) : (plain.flows?.[flowIndex]?.nodes ?? [])
    const edges = [...(allNodes[nodeIndex]?.out ?? [])]
    if (input.index < 0 || input.index >= edges.length) {
      return { ok: false, message: `「${input.from}」没有第 ${String(input.index + 1)} 条出边` }
    }

    if (input.when === undefined) return { ok: true }
    const when = input.when
    /** 条件空着就把 `when` 整个去掉——文件里只该出现「有条件」这个例外。 */
    edges[input.index] = when.length === 0
      ? (() => {
        const { when: _drop, ...rest } = edges[input.index] as Record<string, unknown>
        return rest
      })()
      : { ...edges[input.index], when }

    doc.setIn(at('out'), edges)
    await writeTextFile(path, doc.toString())
    await this.reloadRules()
    return { ok: true }
  }
  /**
   * 新建一条规则：建一个子工作流文件、在事件流里加一个 `workflow` 节点、再连到 `from`。
   *
   * 这是「新建规则」的一步到位版本。手写 YAML 时要建文件、加节点、连线三处一起改，
   * 少了哪步都不成图；这里一次做完，失败则不留半成品（先写子工作流，再改事件流，
   * 后者失败时把前者删掉）。
   * @param input - 哪个事件流、从哪个节点连出去、规则叫什么。
   * @returns 成功，以及新节点 id 与新边的下标。
   */
  async addRule(input: {
    readonly flowId: string
    readonly from: string
    readonly name: string
    readonly when?: readonly Readonly<Record<string, unknown>>[]
  }): Promise<TaskEdit & { readonly nodeId?: string; readonly edgeIndex?: number }> {
    const name = input.name.trim()
    if (name === '') return { ok: false, message: '规则得有个名字' }

    const located = this.locateFlow(input.from, input.flowId)
    if (located === undefined) return { ok: false, message: `找不到节点「${input.from}」所属的图` }
    if (located.flow.trigger === undefined) {
      return { ok: false, message: '这是子工作流；规则只能从事件流里加' }
    }

    /** 规则 id：中文名转不了 slug 时退回时间戳，保证文件能建出来。 */
    const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const ruleId = this.freeFlowId('rule', ascii)
    const nodeId = 'call-' + ruleId

    if (this.workflows.has(ruleId)) return { ok: false, message: `已经有叫「${ruleId}」的子工作流了` }
    if (located.flow.nodes.some(node => node.id === nodeId)) {
      return { ok: false, message: `事件流里已经有「${nodeId}」这个节点了` }
    }

    // 1) 先建子工作流文件：开始 → 结束。入参/出参在「开始/结束」里声明，
    //    没有开始节点的话，谁传了什么、缺什么只能去读调用方那一侧。
    const workflowPath = join(this.workflowsDir, ruleId + '.yml')
    try {
      mkdirSync(this.workflowsDir, { recursive: true })
      writeFileSync(
        workflowPath,
        stringifyFlowDocument(
          {
            id: ruleId,
            name,
            connector: located.flow.connector,
            nodes: [
              { id: 'start', type: 'start', out: [{ to: 'end' }] },
              { id: 'end', type: 'end' },
            ],
          },
          { header: '新建的规则流程：在「开始」和「结束」之间加它要做的事。' },
        ),
        'utf8',
      )
    } catch (error: unknown) {
      return { ok: false, message: '建子工作流失败：' + (error instanceof Error ? error.message : String(error)) }
    }

    // 2) 再加节点与边。失败就把刚建的文件删掉，不留半成品。
    // 2) 节点与边**一次写完**：分两步做的话，先连线会报「找不到目标节点」，
    //    先建节点又要重读一次文件——都不如读完改完一次落盘。
    let raw = ''
    try { raw = readFileSync(located.path, 'utf8') } catch { raw = '' }
    const abort = (message: string): TaskEdit & { nodeId?: string; edgeIndex?: number } => {
      try { rmSync(workflowPath, { force: true }) } catch { /* 删不掉就留着，下次同名会被拒 */ }
      return { ok: false, message }
    }
    if (raw === '') return abort('读不到规则文件：' + located.path)
    let doc
    try {
      doc = parseYaml(raw)
    } catch (error: unknown) {
      return abort('规则文件读不出来：' + (error instanceof Error ? error.message : String(error)))
    }
    if (doc.errors.length > 0) return abort('规则文件有语法错误，先修好它：' + (doc.errors[0]?.message ?? ''))

    const fromFound = locateNode(doc, input.from)
    if (fromFound === undefined) return abort(`文件里找不到节点「${input.from}」`)
    const plain = doc.toJS() as {
      nodes?: { id?: string; type?: string; config?: Record<string, unknown>; out?: Record<string, unknown>[] }[]
      flows?: { nodes?: { id?: string; type?: string; config?: Record<string, unknown>; out?: Record<string, unknown>[] }[] }[]
    }
    const single = fromFound.flowIndex < 0
    const nodes = single ? (plain.nodes ?? []) : (plain.flows?.[fromFound.flowIndex]?.nodes ?? [])
    const fromIndex = nodes.findIndex(item => item.id === input.from)
    if (fromIndex < 0) return abort(`文件里找不到节点「${input.from}」`)

    // 新节点排在最末的 `end` 之前，读起来比塞在末尾自然。
    const endIndex = nodes.findIndex(item => item.type === 'end')
    const insertAt = endIndex < 0 ? nodes.length : endIndex
    nodes.splice(insertAt, 0, { id: nodeId, type: 'workflow', config: { workflow: ruleId }, out: [{ to: 'end' }] })

    const edges = [...(nodes[fromIndex]?.out ?? [])]
    /**
     * 新规则插在**第一个无条件边之前**。
     *
     * 分支按顺序判、第一条命中的生效，而无条件边就是兜底：追加到它后面等于「永远不会
     * 命中」——界面上刚建完就会弹「第 N 条是无条件兜底，它后面还有 1 条」。新建一条规则
     * 的本意是让它生效，不是让它排在兜底后面等着。
     */
    const firstCatchAll = edges.findIndex(edge => (Array.isArray(edge['when']) ? edge['when'] : []).length === 0)
    const edgeIndex = firstCatchAll < 0 ? edges.length : firstCatchAll
    edges.splice(edgeIndex, 0, {
      to: nodeId,
      ...(input.when === undefined || input.when.length === 0 ? {} : { when: input.when }),
    })
    nodes[fromIndex] = { ...nodes[fromIndex], out: edges }

    const nodesAt = (): (string | number)[] => (single ? ['nodes'] : ['flows', fromFound.flowIndex, 'nodes'])
    doc.setIn(nodesAt(), nodes)
    await writeTextFile(located.path, doc.toString())
    await this.reloadRules()
    return { ok: true, nodeId, edgeIndex }
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
    // **不能在 `currentFlows` 里找**：事件流模式下那个数组是空的（规则都在
    // `eventFlows` / `workflows` 里），于是永远定位不到文件，保存只能退回 `rules.yml`，
    // 报「文件里找不到节点」。
    const candidates = [
      ...this.eventFlows.values(),
      ...this.workflows.values(),
      ...this.currentFlows,
    ]
    for (const flow of candidates) {
      if (flowId !== undefined && flow.id !== flowId) continue
      // v1 合集模式（规则全写在 `rules.yml` 里）没有「图 → 文件」的映射，回退到那份文件。
      const path = this.flowFiles.get(flow.id) ?? this.rulesPath
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
  private loadFlowDoc(nodeId?: string, flowId?: string): {
    readonly ok: true
    readonly doc: YamlDoc
    readonly flowIndex: number
    readonly nodes: YamlSeq
    /** 这份图的文件：**写回时必须用它**，不能写死 `rules.yml`。 */
    readonly path: string
  } | { readonly ok: false; readonly message: string } {
    const located = this.locateFlow(nodeId, flowId)
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
      return { ok: true, doc, flowIndex: -1, nodes: rootNodes, path }
    }

    const flows = doc.getIn(['flows']) as YamlSeq | undefined
    if (flows === undefined || !Array.isArray(flows.items) || flows.items.length === 0) {
      return { ok: false, message: '这份规则文件里没有流程图' }
    }
    const nodes = doc.getIn(['flows', 0, 'nodes']) as YamlSeq | undefined
    if (nodes === undefined || !Array.isArray(nodes.items)) {
      return { ok: false, message: '第一张流程图没有节点列表' }
    }
    return { ok: true, doc, flowIndex: 0, nodes, path }
  }

  /** 造一个这张图里没被占用的节点 id。 */
  private freeNodeId(doc: YamlDoc, flowIndex: number, type: string): string {
    const data = doc.toJS() as {
      nodes?: { id?: string }[]
      flows?: { nodes?: { id?: string }[] }[]
    }
    // 一图一文件时节点在根上；只看 `flows[i]` 会让生成器以为图是空的，造出重名 id。
    const existing = flowIndex < 0 ? (data.nodes ?? []) : (data.flows?.[flowIndex]?.nodes ?? [])
    const taken = new Set(existing.map(node => node.id))
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

/**
 * 在文件里定位一张图。
 *
 * 单图文件返回 `-1`（图就在根上），合集文件返回它在 `flows` 里的序号。
 * @param doc - 解析后的 YAML 文档。
 * @param flowId - 图 id。
 * @returns 图序号；找不到为 undefined。
 */
function locateFlowIndex(doc: { toJS: () => unknown }, flowId: string): number {
  const data = doc.toJS()
  if (!isRecord(data)) return -1
  if (Array.isArray(data['nodes']) && data['id'] === flowId) return -1
  if (!Array.isArray(data['flows'])) return -1
  for (const [index, flow] of data['flows'].entries()) {
    if (isRecord(flow) && flow['id'] === flowId) return index
  }
  return -1
}

/** 一个抛出物作为一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
