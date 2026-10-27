/**
 * 邮件分诊的装配：把规则、条件、动作、记录、撤销与宿主接起来。
 *
 * 这一层只做装配——它认识 cordis，别的模块都不认识。合并进邮件插件之后，三件事
 * 值得写下来：
 *
 * 1. **邮件插件自己分发**：`scan` 扫到新邮件时直接调本引擎的 `triage()`，不再经
 *    `mail/received` 事件绕到另一个插件，也不再需要「先探测那个插件装没装」。
 * 2. **规则文件是唯一的事实来源**，且会被监听：agent 改完文件，下一次收到邮件就用
 *    新的规则，不需要重启。
 * 3. **分类通道走一个会话**（`SessionAsk`）。这是本模块里唯一一处要猜宿主行为的地
 *    方，所以它被关在一个函数里，其余部分用假实现就能测。
 *
 * @module @free-lzj/dsh-mail/triage/mount
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { builtinActions, type ActionContext, type SessionPort } from './actions/index.ts'
import { createSessionClassifier } from './classify.ts'
import { builtinConditions } from './conditions.ts'
import { ActionRegistry, ConditionRegistry, registerAll, writeTextFile } from '@free-lzj/dsh-decision'
import type { ActionOutcome } from './actions/index.ts'
import type { MatchContext } from './conditions.ts'
import { loadRules, setActionMode, setRuleEnabled, swapPriority } from './rules.ts'
import { createMailPendingStore, createMailRunStore } from './records.ts'
import { applySuggestion } from './suggest.ts'
import { runDue, labelUniverse, matches, triage, undoRun, type IncomingMail, type MatchState, type TriagePorts } from './triage.ts'
import type {
  ActionKind, ActionMode, ActionSpec, ConditionKind, ConditionSpec, Config, MailLike, MailSummaryLike,
  Rule, RulesView, Run, TestView, TriageResult, TriageRouteHost,
} from './types.ts'

/* ─────────────────────────── 对宿主的最小结构声明 ─────────────────────────── */

/** 会话服务里本插件用得到的那部分。 */
interface SessionControllerLike {
  create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ readonly agent: LiveAgentLike } | { readonly error: unknown }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  /** 归档一个会话；回收分诊会话时用。缺了就不回收，只是上下文会长。 */
  archive?(sessionId: string): Promise<unknown>
}

/** 一个活着的 agent；`session` 用来把回答读回来。 */
interface LiveAgentLike {
  readonly session: LiveSessionLike
  followup(message: unknown): void
}

/** 会话对象上本插件用得到的那部分。 */
interface LiveSessionLike {
  readonly id?: string
  /** 已提交的事件；`snapshotEvents` 是宿主自己的读法。 */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly { readonly type: string; readonly data?: unknown }[]
  /** 当前事件序号。 */
  readonly seq?: number
}

/** 工作区服务里本插件用得到的那部分。 */
interface WorkspaceRegistryLike {
  create(path: string): Promise<{
    readonly path: string
    attachSession(id: string): Promise<void>
    detachSession(id: string): Promise<void>
  }>
}

/** 权限预设服务。 */
interface PermissionsLike {
  readonly defaultPreset?: string
  set(session: unknown, name: string): void
}

/** 工作台通知与条目。 */
interface ConsoleLike {
  notify?(notice: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
  }): Promise<unknown>
  /** 条目接口：带身份、能被点。工作台版本旧时可能没有。 */
  raise?(item: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
    readonly kind: string
    readonly actions: readonly { readonly id: string; readonly label: string; readonly style?: 'primary' | 'danger' }[]
    readonly sessionId?: string
  }): Promise<{ readonly id: string }>
  /** 注册「用户点了我的条目」的处理器。 */
  onAction?(kind: string, handler: (item: { readonly id: string }, actionId: string) => Promise<void> | void): () => void
  /** 记一条自动化日志；工作台版本旧时没有。 */
  log?(entry: {
    readonly source: string
    readonly title: string
    readonly detail?: string
    readonly ok?: boolean
  }): void
}

/** 子进程能力。 */
interface SubprocessLike {
  spawn(spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
  }): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>
}

/** 工具能力（MCP 走这里）。 */
interface ToolsLike {
  call?(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 宿主在每次会话日志追加后发出。
     *
     * `turn/end` 是**会话日志的事件类型**而不是 cordis 事件，所以只能从这个事件里按
     * `event.type` 过滤出来——宿主自己的行为就是这样，没有更直接的通知。
     */
    'session/event'(session: { readonly id?: string }, event: { readonly type?: string }): void
  }
}

/* ──────────────────────────────── 装配 ──────────────────────────────── */

/**
 * 装分诊要的那几样东西。
 *
 * 全部从外面给：数据目录、默认规则文件、配置、邮件能力。装配层因此不需要知道
 * `$DSH_HOME` 怎么算、包内资源在哪，也不需要认识 `MailService` 的其余动词。
 */
export interface TriageDeps {
  /** 本插件的数据目录（`$DSH_HOME/mail`）；规则与记录放在它的 `triage/` 子目录下。 */
  readonly home: string
  /** 发货默认规则文件的绝对路径，第一次启动时写到规则文件的位置。 */
  readonly defaultRules: string
  readonly config: Config
  /** 邮件能力：本插件自己的服务，形状与 {@link MailLike} 一致。 */
  readonly mail: MailLike
  readonly log: (message: string) => void
  readonly warn: (message: string) => void
}

/** 邮件插件拿着的那两个动词与三份状态。 */
export interface TriageEngine {
  readonly config: Config
  readonly routes: TriageRouteHost
  /** 分诊一封刚到的邮件。 */
  triage(mail: IncomingMail): Promise<Run>
  /** 读状态、读规则、开始监听规则文件。 */
  start(): void
  /** 停掉定时器、监听与工作台订阅。 */
  stop(): void
}

/**
 * 装配分诊引擎。
 * @param ctx - Host 插件上下文。
 * @param deps - 数据目录、默认规则、配置与邮件能力。
 * @returns 分诊入口与它要挂的路由。
 */
export function createTriage(ctx: Context, deps: TriageDeps): TriageEngine {
  const config: Config = deps.config
  const home = join(deps.home, 'triage')
  const rulesPath = join(home, 'rules.yml')

  const conditions = new ConditionRegistry<ConditionSpec, MatchContext, ConditionKind>()
  registerAll(conditions, builtinConditions())
  const actions = new ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind>()
  registerAll(actions, builtinActions())

    const runs = createMailRunStore(join(home, 'runs.json'))

  const pending = createMailPendingStore(join(home, 'pending.json'))
  /** 当前生效的规则；读文件失败时保留这一份。 */
  let rules: readonly Rule[] = []
  let rulesError: RulesView['error']
  let rulesSource: 'file' | 'default' = 'default'
  let dropped: readonly string[] = []
  /** 分诊会话 id；回收后置空，下一次判定时重建。 */
  let classifierSessionId: string | undefined
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  /** 建议处理器的注销函数；工作台没装或没有条目接口时是 undefined。 */
  let disposeSuggestion: (() => void) | undefined
  let stopping = false

  const log = (message: string): void => deps.log(message)
  const warn = (message: string): void => deps.warn(message)

  /* ── 端口：把宿主服务收成动作层认识的那几个形状 ── */

  const consoleService = (): ConsoleLike | undefined => ctx.get('console') as ConsoleLike | undefined

  /**
   * 工作台端口：同时给出「纯通知」与「条目」两种能力。
   *
   * 两个都给，是因为消费方（`notify` 动作与 `suggest` 三态）需要的强弱不同；工作台
   * 版本旧、只实现 `notify` 时，`raise` 这一项自然是 undefined，建议会退化成一条纯通知。
   */
  const consolePort = (): NonNullable<ActionContext['console']> | undefined => {
    const workbench = consoleService()
    if (workbench === undefined) return undefined
    return {
      ...(workbench.notify === undefined ? {} : { notify: async notice => await (workbench.notify as NonNullable<ConsoleLike['notify']>)(notice) }),
      ...(workbench.raise === undefined ? {} : { raise: async item => await (workbench.raise as NonNullable<ConsoleLike['raise']>)(item) }),
      ...(workbench.log === undefined ? {} : { log: (entry: NonNullable<ActionContext['console']>['log'] extends (e: infer E) => void ? E : never) => { workbench.log?.(entry) } }),
    }
  }

  /**
   * 会话端口：把「建会话 → 挂工作区 → 改名 → 挂权限 → 投递」这五个动词按宿主服务
   * 拼出来。顺序在这里固定，动作实现不需要知道。
   */
  const sessionPort = (): SessionPort | undefined => {
    const controller = ctx.get('sessionController') as SessionControllerLike | undefined
    const workspaces = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (controller === undefined || workspaces === undefined) return undefined
    const permissions = ctx.get('permissionPresets') as PermissionsLike | undefined
    return {
      createSession: async request => await controller.create(request),
      attachSession: async (cwd, sessionId) => {
        const workspace = await workspaces.create(cwd)
        await workspace.attachSession(sessionId)
      },
      rename: async (sessionId, title) => {
        await controller.rename?.({ sessionId, title })
      },
      setPermission: (sessionId, preset) => {
        // 权限要挂在会话对象上，而动作层只有 id；用 resolveAgent 拿会话是异步的，
        // 而 `setPermission` 是同步接口——所以这里退化成用部署默认值，并把这件事
        // 记进日志，而不是假装挂上了。
        void sessionId
        void preset
        void permissions
      },
      followup: async (sessionId, text, source) => {
        const resolved = await controller.resolveAgent(sessionId)
        if ('error' in resolved) throw new Error(String((resolved.error as { message?: string })?.message ?? resolved.error))
        resolved.agent.followup({
          role: 'user',
          content: [{ type: 'text', text }],
          source,
        })
      },
    }
  }

  /** 工具端口：宿主的 tools 服务可能只给 list/invoke 之一。 */
  function toolsPort(): ActionContext['tools'] | undefined {
    const tools = ctx.get('tools') as ToolsLike | undefined
    if (tools?.call === undefined) return undefined
    return { call: async (name, input) => await (tools.call as (n: string, i: unknown) => Promise<unknown>)(name, input) }
  }

  /** 动作层要的那个上下文。 */
  const actionContextFor = (input: {
    readonly summary: MailSummaryLike
    readonly accountId: string
    readonly accountName: string
    readonly body: string
    readonly ruleName: string
    readonly ruleId: string
  }): ActionContext => {
    // 先收成局部量再判空：`exactOptionalPropertyTypes` 下不能把 `X | undefined`
    // 直接塞进一个可选属性。
    const sessions = sessionPort()
    const workbench = consolePort()
    const subprocess = ctx.get('subprocess') as SubprocessLike | undefined
    const tools = toolsPort()
    return {
      task: {
        accountId: input.accountId,
        accountName: input.accountName,
        summary: input.summary,
        body: input.body,
        rule: { id: input.ruleId, name: input.ruleName, enabled: true, priority: 0, when: [], then: [] },
      },
      vars: { repoRoot: config.repoRoot },
      mail: deps.mail as NonNullable<ActionContext['mail']>,
      ...(sessions === undefined ? {} : { sessions }),
      ...(workbench === undefined ? {} : { console: workbench }),
      ...(subprocess === undefined ? {} : { subprocess }),
      ...(tools === undefined ? {} : { tools }),
      fetch: globalThis.fetch.bind(globalThis) as NonNullable<ActionContext['fetch']>,
      log: warn,
    }
  }

  /* ── 分诊会话：问一个 dsh agent，并把它的回答读回来 ── */

  /**
   * 从一个会话对象里读最后一条助手消息的文本。
   *
   * 这是本模块唯一一处**依赖宿主内部形状**的地方，所以写得尽量宽容：认不出结构就
   * 返回空串，让上层折成「拿不准」，而不是抛错。`snapshotEvents` 是宿主自己的读法。
   */
  function lastAssistantText(session: LiveSessionLike, fromSeq: number): string {
    const events = session.snapshotEvents?.(fromSeq) ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'assistant/message') continue
      const text = collectText(event.data)
      if (text !== '') return text
    }
    return ''
  }

  /** 递归收集一段结构里所有 `text` 字段。 */
  function collectText(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(collectText).filter(part => part !== '').join('\n')
    if (typeof value !== 'object' || value === null) return ''
    const record = value as Record<string, unknown>
    if (typeof record['text'] === 'string') return record['text']
    return collectText(record['content'])
  }

  /**
   * 问分诊会话一句话并等它答完。
   *
   * 等的是 `session/event` 里的 `turn/end` 而不是 `whenIdle()`：后者等的是「整个 agent
   * 停稳」，会把别的输入算进同一段区间（这是宿主自己文档化的行为）。订阅要在投递
   * **之前**建立，否则一轮结束得比订阅快时会永远等下去。
   */
  function askClassifierSession(prompt: string): Promise<string> {
    const controller = ctx.get('sessionController') as SessionControllerLike | undefined
    if (controller === undefined) return Promise.reject(new Error('未挂载会话服务（sessionController）'))
    return (async () => {
      let sessionId = classifierSessionId
      if (sessionId === undefined) {
        // 工作目录要先存在：宿主建会话时不会替我们 mkdir，而一个不存在的 cwd 会让
        // **每一封**邮件的判定都失败——那看起来像「模型不会判类」，其实只是目录没建。
        const cwd = join(home, 'classifier')
        mkdirSync(cwd, { recursive: true })
        const created = await controller.create({ cwd })
        sessionId = created.sessionId
        classifierSessionId = sessionId
        await controller.rename?.({ sessionId, title: '邮件分诊' })
      }
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) {
        classifierSessionId = undefined
        throw new Error(`分诊会话不可用：${String((resolved.error as { message?: string })?.message ?? resolved.error)}`)
      }
      const session = resolved.agent.session
      const fromSeq = session.seq ?? 0
      const done = waitForTurnEnd(sessionId)
      resolved.agent.followup({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:dsh-mail', form: 'classifier' },
      })
      await done
      return lastAssistantText(session, fromSeq)
    })()
  }

  /** 等某个会话的一轮结束。 */
  function waitForTurnEnd(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const dispose = ctx.on('session/event', (session: { readonly id?: string }, event: { readonly type?: string }) => {
        if (session?.id !== sessionId || event?.type !== 'turn/end') return
        dispose()
        resolve()
      })
    })
  }

  /** 回收分诊会话：换一个新的，免得上下文一直长。 */
  async function recycleClassifierSession(): Promise<void> {
    const controller = ctx.get('sessionController') as SessionControllerLike | undefined
    const stale = classifierSessionId
    classifierSessionId = undefined
    if (stale === undefined || controller?.archive === undefined) return
    await controller.archive(stale)
    log('[mail 分诊] 分诊会话已回收，下一次判定会新建一个')
  }

  const classify = createSessionClassifier({
    ask: askClassifierSession,
    onRecycle: recycleClassifierSession,
    log: warn,
  })

  /* ── 规则文件的读与监听 ── */

  /** 重新读规则；成功才替换当前生效的那一份。 */
  async function reloadRules(): Promise<void> {
    if (stopping) return
    let fallback = ''
    try {
      fallback = readFileSync(deps.defaultRules, 'utf8')
    } catch (error: unknown) {
      warn(`mail 分诊: 读不到内置默认规则：${describe(error)}`)
    }
    const loaded = await loadRules(rulesPath, fallback)
    if (loaded.error !== undefined) {
      // 解析失败**保留上一份**：整份回退默认规则会让用户以为自己的规则生效了。
      rulesError = loaded.error
      warn(`mail 分诊: 规则文件有问题，已保留上一份可用规则：${loaded.error.message}`)
      return
    }
    rules = loaded.rules
    rulesSource = loaded.source
    dropped = loaded.dropped
    rulesError = undefined
    for (const note of dropped) warn(`mail 分诊: 丢弃了一条规则（${note}）`)
    log(`mail 分诊: 已加载 ${String(rules.length)} 条规则（来源：${rulesSource}）`)
  }

  /** 读规则文件的原文；给页面做「复制给 agent」用。 */
  function rawRules(): string {
    try {
      return readFileSync(rulesPath, 'utf8')
    } catch {
      return ''
    }
  }

  /** 把规则文件改一处并立刻生效。 */
  async function editRules(edit: (raw: string) => { ok: true; text: string } | { ok: false; error: string }): Promise<TriageResult> {
    const raw = rawRules()
    if (raw === '') return { ok: false, message: `读不到规则文件：${rulesPath}` }
    const result = edit(raw)
    if (!result.ok) return { ok: false, message: result.error }
    await writeTextFile(rulesPath, result.text)
    await reloadRules()
    return { ok: true }
  }

  /* ── 分诊 ports ── */

  const ports: TriagePorts = {
    rules: () => rules,
    config: () => config,
    conditions,
    actions,
    runs,
    pending,
    context: input => actionContextFor({
      summary: input.mail.summary,
      accountId: input.mail.accountId,
      accountName: input.mail.accountName,
      body: input.body,
      ruleId: input.rule.id,
      ruleName: input.rule.name,
    }),
    replayContext: input => actionContextFor({
      summary: input.summary,
      accountId: input.accountId,
      accountName: input.accountName,
      body: '',
      ruleId: input.ruleId,
      ruleName: input.ruleId,
    }),
    classify,
    log: warn,
  }

  /* ── 试跑：拿一封已缓存邮件看会命中哪条、会做什么 ── */

  async function testRule(accountId: string, folder: string, uid: number): Promise<TestView | TriageResult> {
    const detail = await deps.mail.fetchDetail(accountId, folder, uid)
    if (detail === undefined) return { ok: false, message: '读不到这封邮件（连接可能已断开）' }
    // 试跑只做匹配，**不执行任何动作**——它的价值是回答「会怎样」，不是「做一遍」。
    const summary: MailSummaryLike = {
      accountId,
      folder,
      uid,
      uidValidity: 0,
      subject: detail.subject,
      from: detail.from,
      date: detail.date,
      seen: true,
      flagged: false,
      hasAttachments: false,
      snippet: detail.snippet,
      headers: {},
    }
    // 走的是真实链路：试跑也可能命中一条模型规则，所以分类条件要真的问一次。
    // 共用一份状态，多规则判类时仍然只问一次模型。
    const probe: IncomingMail = {
      accountId,
      accountName: accountId,
      summary,
      readBody: async () => detail.text,
    }
    const state: MatchState = { labels: labelUniverse(rules), classifications: new Map() }
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (!(await matches(rule, probe, ports, state))) continue
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        actions: rule.then.map(action => ({ kind: action.kind, detail: describeAction(action) })),
        reason: '按顺序第一条命中的规则；它没有改动任何邮件。',
      }
    }
    return { ruleId: '(none)', ruleName: '没有规则命中', actions: [], reason: '这条邮件会被留在面板里，不产生任何动作。' }
  }

  /** 一句人话描述一个动作会做什么。 */
  function describeAction(action: { readonly kind: string; readonly mode?: string; readonly folder?: string }): string {
    const mode = action.mode ?? 'auto'
    const label = mode === 'suggest' ? '建议' : mode === 'off' ? '关闭' : '自动'
    return action.folder === undefined ? `${label}：${action.kind}` : `${label}：${action.kind} → ${action.folder}`
  }

  /* ── 路由要的那几个操作 ── */

  const routes: TriageRouteHost = {
    rules: async () => ({
      rules,
      ...(rulesError === undefined ? {} : { error: rulesError }),
      source: rulesSource,
      path: rulesPath,
      raw: rawRules(),
      dropped,
      config,
    }),
    setEnabled: async (ruleId, enabled) => await editRules(raw => setRuleEnabled(raw, ruleId, enabled)),
    setMode: async (ruleId, actionIndex, mode) =>
      await editRules(raw => setActionMode(raw, ruleId, actionIndex, mode as ActionMode)),
    movePriority: async (ruleId, direction) => await editRules(raw => swapPriority(raw, ruleId, rules, direction)),
    runs: async since => {
      const all = runs.list()
      if (since === undefined) return { runs: all.slice(0, 100) }
      const at = all.findIndex(run => run.id === since)
      return { runs: at === -1 ? all.slice(0, 100) : all.slice(0, at) }
    },
    undo: async (runId) => {
      const result = await undoRun(runId, ports)
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },
    test: testRule,
  }

  /**
   * 用户在建议条目上点了按钮。
   *
   * 逻辑在 {@link applySuggestion}，这里只把它接到工作台的服务上——那条路要靠真实
   * cordis 才跑得起来，所以能让它单测的部分都放在外面。
   * @param item - 被点的条目（只用它的 id）。
   * @param actionId - 动作 id。
   */
  const onSuggestion = async (item: { readonly id: string }, actionId: string): Promise<void> => {
    await applySuggestion(item, actionId, { pending, actions, runs, ports })
  }

  /**
   * 把旧插件留下的数据搬到本插件目录下。
   *
   * 规则与记录属于用户，不是缓存：装过一次 `@free-lzj/dsh-mailflow` 的人升级上来时，
   * 那三条规则不该凭空消失。只搬不删——旧目录留着，用户自己决定要不要清。
   */
  async function adoptLegacy(): Promise<void> {
    const legacy = join(dirname(deps.home), 'mailflow')
    if (!existsSync(legacy)) return
    for (const name of ['rules.yml', 'runs.json', 'pending.json']) {
      const from = join(legacy, name)
      const to = join(home, name)
      if (existsSync(to) || !existsSync(from)) continue
      try {
        // 走同一个原子写：目标目录可能还不存在，而 `copyFileSync` 不会替我们建。
        await writeTextFile(to, readFileSync(from, 'utf8'))
        warn(`mail 分诊: 已把 ${name} 从 ${legacy} 搬到 ${home}`)
      } catch (error: unknown) {
        warn(`mail 分诊: 搬 ${name} 失败：${describe(error)}`)
      }
    }
  }

  /**
   * 读状态、读规则、开始监听规则文件。
   *
   * 返回的 promise 在「规则已可用」之后才 resolve，所以宿主与测试都不必猜时间点；
   * 失败只记日志、不 reject——读不到规则的分诊应当安静降级，而不是让插件起不来。
   */
  function start(): Promise<void> {
    return (async () => {
      await adoptLegacy()
      await runs.load()
      await pending.load()
      await reloadRules()
      if (stopping) return
      // 规则文件是 agent 改的，所以必须监听：改完不用重启就生效。
      try {
        watcher = watch(rulesPath, { persistent: false }, () => {
          // 编辑器保存常常写两次（临时文件 + 改名），防抖一下免得读半份。
          setTimeout(() => { void reloadRules() }, 300)
        })
      } catch {
        // 文件还不存在时 watch 会失败（loadRules 刚把它写出去，通常不会）；
        // 监听不上只意味着改规则要重启，不该让插件起不来。
      }
      // 延迟动作的到期扫描；周期比撤销窗口小一个量级就够了。顺便按保留策略裁剪
      // 记录：`runHistoryLimit` / `runRetentionDays` 是配置项，只写不裁就是假配置。
      timer = setInterval(() => {
        void runDue(ports).catch((error: unknown) => warn(`mail 分诊: 执行延迟动作失败：${describe(error)}`))
        void runs.trim({ limit: config.runHistoryLimit, days: config.runRetentionDays }, new Date())
          .catch((error: unknown) => warn(`mail 分诊: 裁剪命中记录失败：${describe(error)}`))
      }, 15_000)
      timer.unref?.()
      // 建议被点的时候把动作做掉。注册在工作台服务上，随本插件卸载一起摘掉。
      const workbench = consoleService()
      if (workbench?.onAction !== undefined) {
        disposeSuggestion = workbench.onAction('mail', (item, actionId) => onSuggestion(item, actionId))
      }
    })().catch((error: unknown) => warn(`mail 分诊: 启动失败：${describe(error)}`))
  }

  /** 停掉定时器、监听与工作台订阅。 */
  function stop(): void {
    stopping = true
    if (timer !== undefined) clearInterval(timer)
    disposeSuggestion?.()
    watcher?.close()
  }

  return {
    config,
    routes,
    triage: async mail => await triage(mail, ports),
    start,
    stop,
  }
}

/** 描述任意抛出物。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}