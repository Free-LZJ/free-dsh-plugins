/**
 * 规则引擎：把内核的零件装成一台能跑的机器，但仍然不认识任何来源。
 *
 * 这是「规则归工作台、连接器只负责喂事件」那件事的落点。引擎独占三份状态——规则文件、
 * 命中记录、待确认队列——以及两个注册表；它知道**怎么**读文件、怎么排队、怎么撤销、
 * 什么时候执行到期的动作，但不知道一个事件长什么样，也不知道有哪些条件与动作。
 * 那些全部由连接器在 {@link DecisionEngine.use} 里交给它。
 *
 * 三条设计取舍：
 *
 * 1. **一个引擎一个连接器。** 词表是规则文件那门语言的语法，两份词表读同一份文件
 *    只会互相把对方的规则当成写歪的条目丢掉。所以第二个连接器拿不到这个引擎
 *    （`use` 返回 false），它该自己建一个——用另一份文件。
 * 2. **没有连接器是正常状态**，不是错误：工作台永远先起来，连接器后装。此时
 *    `view().connector === false`，页面据此说「还没有连接器提供规则」，而不是画一份
 *    空规则表让人以为装错了。
 * 3. **撤销与到期执行在这里，不在连接器里。** 它们只依赖「一条排队记录 + 一个动作 +
 *    一个能造出上下文的回调」，而这四样引擎都有；留在编排层就会变成两处各写一遍，
 *    而两处写同一份队列迟早起冲突。
 *
 * 纯库：不 import cordis，不认识 `$DSH_HOME`（目录从外面给），也不认任何实现的名字。
 *
 * @module @free-lzj/dsh-decision/engine
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { runDueActions } from './actions/due.ts'
import { undoRunById } from './actions/undo.ts'
import type { DecisionConfigBase, RuleVocabulary } from './config.ts'
import type { PendingRecord, PendingStore } from './pending.ts'
import { loadRuleFile, setActionMode, setConditionValues, setRuleEnabled, swapPriority, type EditResult } from './rules.ts'
import {
  ActionRegistry, ConditionRegistry, registerAll, type Action, type ActionSpecLike, type Condition,
  type ConditionSpecLike,
} from './registry.ts'
import type { Run, RunAction, RunStatus, RunStore } from './runs.ts'
import { writeTextFile } from './store.ts'
import type { Rule, RuleFileError } from './types.ts'

/** 规则文件里常见的三份状态文件名：迁移时按这三个名字搬。 */
export const RULE_STATE_FILES = ['rules.yml', 'runs.json', 'pending.json'] as const

/**
 * 任何连接器的动作回答的那一个形状。
 *
 * 与 `ActionResult` 相比多两样：`sessionId`（建出的会话，页面能点进去）与 `undo`
 * （回滚这次动作的闭包）。引擎只把它们转手，不理解它们的含义。
 */
export interface EngineOutcome {
  readonly ok: boolean
  /** 给人看的一行说明，含失败原因。 */
  readonly detail: string
  readonly sessionId?: string
  readonly undo?: () => Promise<void>
}

/** 排队记录里引擎真正读的那几个字段；其余都是连接器的。 */
export interface EnginePending extends PendingRecord {
  readonly runId: string
  /** 它是 `then` 里的第几个；执行完要回填那条命中记录的这一项。 */
  readonly actionIndex: number
  readonly action: ActionSpecLike
}

/** 规则文件的只读视图：页面画的就是这一份。 */
export interface RulesFileView {
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
   * 有没有连接器挂上来。
   *
   * `false` 时规则表一定是空的，但那不是「规则文件里没有规则」——是**还没有谁提供
   * 规则**，页面要说清这两件事的区别。
   */
  readonly connector: boolean
}

/** 一次写操作的结果。 */
export interface EngineEdit {
  readonly ok: boolean
  readonly message?: string
}

/** 试跑时要看的那条事件在哪；字段名是连接器与页面共用的最小集合。 */
export interface RuleTestRef {
  readonly accountId: string
  readonly folder: string
  readonly uid: number
}

/** 试跑的答案：会命中哪条、会做什么、为什么。 */
export interface RuleTest {
  readonly ruleId: string
  readonly ruleName: string
  readonly actions: readonly { readonly kind: string; readonly detail: string }[]
  readonly reason: string
}

/** 试跑的两种结果：答案，或「没能跑」（读不到那条事件）。 */
export type RuleTestAnswer =
  | { readonly ok: true; readonly result: RuleTest }
  | { readonly ok: false; readonly message: string }

/**
 * 连接器交给引擎的一切。
 *
 * 只放引擎**用得到**的东西：词表（收窄规则的字段）、发货默认规则（第一次落盘用）、
 * 两个注册表的内容、三份状态里属于连接器的那两个仓、判定配置、重放上下文，以及
 * 旧目录清单。引擎不读这里任何一处的「是什么」，只按形状用。
 */
export interface EngineConnector {
  readonly vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>
  /** 规则文件不存在时写出去的那份文本（连接器随包发的默认规则）。 */
  readonly defaultRules: string
  readonly conditions: readonly Condition<ConditionSpecLike, unknown>[]
  readonly actions: readonly Action<ActionSpecLike, unknown, EngineOutcome>[]
  /**
   * 命中记录的仓，建在 {@link DecisionEngine.runsPath} 上。
   *
   * 「一条记录长什么样」是连接器的知识（它要认回旧形状），所以仓由它建好交进来；
   * 引擎只管什么时候读、什么时候写。连接器自己留着同一个实例做类型化读取也安全：
   * 那是同一个对象，不是第二份状态。
   */
  readonly runs: RunStore<unknown>
  /** 待确认队列，建在 {@link DecisionEngine.pendingPath} 上；理由同上。 */
  readonly pending: PendingStore<EnginePending>
  /** 判定配置：撤销窗口、保留策略。每次用都重新读，所以改配置即时生效。 */
  readonly config: () => DecisionConfigBase
  /**
   * 给一条排队记录造动作上下文。
   *
   * 排队的记录里存着那件事的全部信息（事件摘要、账号、所属规则），所以到期执行与
   * 建议被批准时都能重放，不必回头再读一次源（那时它可能已经被别的客户端动了）。
   */
  readonly replayContext: (record: EnginePending) => unknown
  /**
   * 旧数据目录：启动时把这些目录下的三份状态搬进引擎目录（只搬不删）。
   *
   * 是清单而不是写死的路径，因为「上一个版本把文件放哪」是连接器自己的历史。
   */
  readonly legacyHomes?: readonly string[]
  /** 拿一条真实事件试跑当前规则；引擎不认识事件，所以由连接器回答。 */
  readonly test?: (ref: RuleTestRef) => Promise<RuleTestAnswer>
}

/** 造引擎时要的那几个值。 */
export interface DecisionEngineOptions {
  /** 三份状态所在的目录（`rules.yml` / `runs.json` / `pending.json`）。 */
  readonly home: string
  readonly log?: (line: string) => void
  readonly warn?: (line: string) => void
  /** 到期扫描与保留裁剪的周期；测试可以调小。 */
  readonly dueIntervalMs?: number
}

/** 描述任意抛出物。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 一台规则引擎。
 *
 * 生命周期：`new` → （连接器 `use`）→ `start()` → `stop()`。没有连接器时 `start()`
 * 什么都不做，`view()` 说「没有连接器」；连接器晚到也成立，`use()` 会把该读的读一遍。
 */
export class DecisionEngine {
  /** 三份状态所在的目录。 */
  readonly home: string
  readonly rulesPath: string
  readonly runsPath: string
  readonly pendingPath: string
  /** 条件注册表：连接器把自己的实现注册进来，引擎只按 kind 分发。 */
  readonly conditions = new ConditionRegistry<ConditionSpecLike, unknown>()
  /** 动作注册表；同上。 */
  readonly actions = new ActionRegistry<ActionSpecLike, unknown, EngineOutcome>()

  private connector: EngineConnector | undefined
  /** 当前生效的规则；读文件失败时保留这一份。 */
  private currentRules: readonly Rule<ConditionSpecLike, ActionSpecLike>[] = []
  private rulesError: RuleFileError | undefined
  private rulesSource: 'file' | 'default' = 'default'
  private dropped: readonly string[] = []
  private started = false
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  /** 撤销闭包：活在内存里，撤销窗口是分钟级，跨重启的撤销由队列承担。 */
  private readonly undos = new Map<string, (() => Promise<void>)[]>()

  /**
   * @param options - 数据目录与两个日志出口。
   */
  constructor(private readonly options: DecisionEngineOptions) {
    this.home = options.home
    this.rulesPath = join(options.home, 'rules.yml')
    this.runsPath = join(options.home, 'runs.json')
    this.pendingPath = join(options.home, 'pending.json')
  }

  /**
   * 把连接器挂上来：注册它的词表与两个注册表，已启动时顺手读一遍状态。
   *
   * 一个引擎只接一个连接器（见模块注释第 1 条）。同样的那个连接器重复挂是幂等的，
   * 所以热重载不会把自己挡在门外。
   * @param connector - 连接器。
   * @returns 这个连接器是否拿到了这个引擎。
   */
  async use(connector: EngineConnector): Promise<boolean> {
    if (this.connector !== undefined && this.connector !== connector) return false
    this.connector = connector
    this.conditions.clear()
    this.actions.clear()
    registerAll(this.conditions, connector.conditions)
    registerAll(this.actions, connector.actions)
    if (this.started) await this.activate()
    return true
  }

  /**
   * 把连接器摘下来（它卸载了）。
   *
   * 规则、记录与队列都留在磁盘上——它们属于用户，不属于某一次装载；留下的是
   * **没有连接器**的状态，页面据此说「还没有连接器提供规则」。
   */
  unuse(): void {
    if (this.connector === undefined) return
    this.connector = undefined
    this.conditions.clear()
    this.actions.clear()
    this.currentRules = []
    this.dropped = []
    this.rulesError = undefined
    this.rulesSource = 'default'
    this.undos.clear()
    this.stopTimer()
    // 监听也要停：没有连接器就没有人需要知道文件改了，而重新 `use` 会把它们打开。
    this.watcher?.close()
    this.watcher = undefined
  }

  /**
   * 启动：迁移旧数据、读状态、读规则、开始监听与到期扫描。
   *
   * 返回的 promise 在「规则已可用」之后才 resolve，所以宿主与测试都不必猜时间点；
   * 失败只记日志、不 reject——读不到规则的引擎该安静降级，而不是让插件起不来。
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.activate()
    } catch (error: unknown) {
      this.warn(`规则引擎: 启动失败：${describe(error)}`)
    }
  }

  /** 停掉监听与定时器；三份状态留在磁盘上。 */
  stop(): void {
    this.started = false
    this.stopTimer()
    this.watcher?.close()
    this.watcher = undefined
  }

  /** 当前生效的规则（没有连接器时为空）。 */
  rules(): readonly Rule<ConditionSpecLike, ActionSpecLike>[] {
    return this.currentRules
  }

  /** 规则文件的只读视图。 */
  view(): RulesFileView {
    const connector = this.connector !== undefined
    return {
      rules: this.currentRules,
      ...(this.rulesError === undefined ? {} : { error: this.rulesError }),
      source: this.rulesSource,
      path: this.rulesPath,
      raw: connector ? this.rawRules() : '',
      dropped: this.dropped,
      connector,
    }
  }

  /** 重新读规则；成功才替换当前生效的那一份。 */
  async reloadRules(): Promise<void> {
    const connector = this.connector
    if (connector === undefined) return
    const loaded = await loadRuleFile(this.rulesPath, connector.defaultRules, connector.vocabulary)
    // 中途被摘掉或换过：这一份不再属于任何连接器，丢掉。
    if (this.connector !== connector) return
    if (loaded.error !== undefined) {
      // 解析失败**保留上一份**：整份回退默认规则会让用户以为自己的规则生效了。
      this.rulesError = loaded.error
      this.warn(`规则引擎: 规则文件有问题，已保留上一份可用规则：${loaded.error.message}`)
      return
    }
    this.currentRules = loaded.rules
    this.rulesSource = loaded.source
    this.dropped = loaded.dropped
    this.rulesError = undefined
    for (const note of this.dropped) this.warn(`规则引擎: 丢弃了一条规则（${note}）`)
    this.log(`规则引擎: 已加载 ${this.currentRules.length} 条规则（来源：${this.rulesSource}）`)
  }

  /**
   * 开关一条规则。
   * @param id - 规则 id。
   * @param enabled - 目标状态。
   * @returns 结果。
   */
  async setEnabled(id: string, enabled: boolean): Promise<EngineEdit> {
    return await this.applyEdit(raw => setRuleEnabled(raw, id, enabled))
  }

  /**
   * 改一条规则里某个动作的三态。
   * @param id - 规则 id。
   * @param actionIndex - 动作在 `then` 里的下标。
   * @param mode - 目标三态。
   * @returns 结果。
   */
  async setMode(id: string, actionIndex: number, mode: string): Promise<EngineEdit> {
    if (mode !== 'auto' && mode !== 'suggest' && mode !== 'off') {
      return { ok: false, message: `不认识的动作三态：${mode}` }
    }
    return await this.applyEdit(raw => setActionMode(raw, id, actionIndex, mode))
  }

  /**
   * 改一条规则里某个条件的匹配值列表（只改值，不改种类）。
   * @param id - 规则 id。
   * @param conditionIndex - 条件在 `when` 里的下标。
   * @param values - 新的一组值。
   * @returns 结果。
   */
  async setConditionValues(id: string, conditionIndex: number, values: readonly string[]): Promise<EngineEdit> {
    return await this.applyEdit(raw => setConditionValues(raw, id, conditionIndex, values))
  }

  /**
   * 把一条规则上移或下移。
   * @param id - 规则 id。
   * @param direction - 往上还是往下。
   * @returns 结果。
   */
  async movePriority(id: string, direction: 'up' | 'down'): Promise<EngineEdit> {
    return await this.applyEdit(raw => swapPriority(raw, id, this.currentRules, direction))
  }

  /**
   * 命中记录，最新的在前。
   * @param since - 只给这条记录之前的（不含它）；没有时给最近一批。
   * @returns 记录。
   */
  listRuns(since?: string): readonly Run<unknown>[] {
    const runs = this.connector?.runs
    if (runs === undefined) return []
    const all = runs.list()
    if (since === undefined) return all.slice(0, 100)
    const at = all.findIndex(run => run.id === since)
    return at === -1 ? all.slice(0, 100) : all.slice(0, at)
  }

  /**
   * 撤销一条记录。
   *
   * 还在窗口内的排队项被取消（没发生过），已经执行过的按登记过的闭包回滚——这个区别
   * 与逆序回滚的规则在内核里，这里只把「这条记录排队的动作」翻译成「取消它们并数一数」。
   * @param runId - 记录 id。
   * @returns 结果与一句说明。
   */
  async undo(runId: string): Promise<EngineEdit> {
    const stores = this.connector
    if (stores === undefined) return { ok: false, message: '还没有连接器提供规则' }
    const result = await undoRunById(runId, {
      runs: {
        get: id => stores.runs.get(id),
        patch: async (id, change) => await stores.runs.patch(id, { status: change.status as RunStatus }),
      },
      pendingFor: async (id) => {
        const queued = stores.pending.list().filter(item => item.runId === id)
        for (const item of queued) await stores.pending.cancel(item.id)
        return queued.length
      },
      undosFor: id => this.undos.get(id) ?? [],
      log: line => this.warn(line),
    })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }

  /**
   * 执行到期的延迟动作。
   *
   * 窗口内被撤销的项已经不在队列里，剩下到期的才在这里真的发生；每个动作单独执行、
   * 单独记结果，执行完把撤销闭包登记回去——所以执行之后仍然可以撤销，只是那时是
   * 回滚而不是取消。
   * @param now - 现在；测试可钉死。
   * @returns 执行了几条。
   */
  async runDue(now: Date = new Date()): Promise<number> {
    const stores = this.connector
    const connector = this.connector
    if (stores === undefined || connector === undefined) return 0
    const executed = await runDueActions({
      pending: stores.pending,
      runs: {
        get: runId => stores.runs.get(runId),
        patch: async (runId, change) => await stores.runs.patch(runId, {
          status: change.status as RunStatus,
          actions: change.actions as readonly RunAction[],
        }),
      },
      actions: this.actions,
      contextFor: record => connector.replayContext(record),
      recordUndo: (runId, undo) => {
        const existing = this.undos.get(runId) ?? []
        this.undos.set(runId, [...existing, undo])
      },
      log: line => this.warn(line),
    }, now)
    return executed
  }

  /**
   * 登记一个撤销闭包。
   *
   * 编排层执行完一个动作就调它；撤销窗口内撤销、窗口过后回滚，靠的都是这份登记。
   * @param runId - 记录 id。
   * @param undo - 回滚闭包。
   */
  registerUndo(runId: string, undo: () => Promise<void>): void {
    const existing = this.undos.get(runId) ?? []
    this.undos.set(runId, [...existing, undo])
  }

  /**
   * 拿一条真实事件试跑当前规则，不改动任何东西。
   * @param ref - 事件在哪。
   * @returns 连接器的答案；没有连接器时说明原因。
   */
  async test(ref: RuleTestRef): Promise<RuleTestAnswer> {
    const ask = this.connector?.test
    if (ask === undefined) return { ok: false, message: '还没有连接器提供规则' }
    return await ask(ref)
  }

  /* ─────────────────────────────── 内部 ─────────────────────────────── */

  /** 把「该读的读一遍」这件事收成一处：启动与连接器晚到走同一条路。 */
  private async activate(): Promise<void> {
    const connector = this.connector
    if (connector === undefined) return
    await this.adoptLegacy(connector.legacyHomes ?? [])
    if (this.connector !== connector) return
    await connector.runs.load()
    await connector.pending.load()
    await this.reloadRules()
    this.watchRules()
    this.startTimer()
  }

  /**
   * 把旧目录里的三份状态搬过来。
   *
   * 规则与记录属于用户，不是缓存：从一个以前的版本升级上来时，那几条规则不该凭空
   * 消失。**只搬不删**——旧目录留着，用户自己决定要不要清。
   * @param legacy - 旧目录清单。
   */
  private async adoptLegacy(legacy: readonly string[]): Promise<void> {
    for (const directory of legacy) {
      if (!existsSync(directory)) continue
      for (const name of RULE_STATE_FILES) {
        const from = join(directory, name)
        const to = join(this.home, name)
        if (existsSync(to) || !existsSync(from)) continue
        try {
          // 走同一个原子写：目标目录可能还不存在，而 `copyFileSync` 不会替我们建。
          await writeTextFile(to, readFileSync(from, 'utf8'))
          this.warn(`规则引擎: 已把 ${name} 从 ${directory} 搬到 ${this.home}`)
        } catch (error: unknown) {
          this.warn(`规则引擎: 搬 ${name} 失败：${describe(error)}`)
        }
      }
    }
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
      void this.runDue().catch((error: unknown) => this.warn(`规则引擎: 执行延迟动作失败：${describe(error)}`))
      const config = this.tryConfig()
      if (config === undefined) return
      const runs = this.connector?.runs
      if (runs === undefined) return
      void runs.trim({ limit: config.runHistoryLimit, days: config.runRetentionDays }, new Date())
        .catch((error: unknown) => this.warn(`规则引擎: 裁剪命中记录失败：${describe(error)}`))
    }, this.options.dueIntervalMs ?? 15_000)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
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
  private async applyEdit(edit: (raw: string) => EditResult): Promise<EngineEdit> {
    if (this.connector === undefined) return { ok: false, message: '还没有连接器提供规则' }
    const raw = this.rawRules()
    if (raw === '') return { ok: false, message: `读不到规则文件：${this.rulesPath}` }
    const result = edit(raw)
    if (!result.ok) return { ok: false, message: result.error }
    await writeTextFile(this.rulesPath, result.text)
    await this.reloadRules()
    return { ok: true }
  }

  /** 当前配置；没有连接器时用默认值。 */
  private tryConfig(): DecisionConfigBase | undefined {
    const connector = this.connector
    if (connector === undefined) return undefined
    return connector.config()
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  private warn(line: string): void {
    this.options.warn?.(line)
  }
}
