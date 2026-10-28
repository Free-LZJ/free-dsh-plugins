/**
 * 邮件分诊的装配：把规则引擎、条件、动作、记录、撤销与宿主接起来。
 *
 * 这一层认识 cordis，别的模块都不认识。合并进邮件插件之后，四件事值得写下来：
 *
 * 1. **规则引擎不归这里。** 规则文件、命中记录、待确认、撤销与到期执行都在
 *    `@free-lzj/dsh-decision` 的 {@link DecisionEngine} 里；工作台（`@free-lzj/dsh-console`）
 *    的 Host 半边持有那**唯一一份**实例，并通过 `ctx.console.decision` 露出来。本插件优先
 *    把词表注册到它上面——这就是「规则文件只有一份状态」的实现方式。
 * 2. **没装工作台时自己建同一个引擎类**，数据目录也照同一个约定（`$DSH_HOME/dsh-console/rules`），
 *    所以先独跑、后装工作台不会变成两份规则。这是硬要求：没工作台时邮件必须仍能独立分诊。
 * 3. **邮件插件自己分发**：`scan` 扫到新邮件时直接调本模块的 `triage()`。
 * 4. **分类通道走一个会话**（`SessionAsk`）。这是本模块里唯一一处要猜宿主行为的地方，
 *    所以它被关在一个函数里，其余部分用假实现就能测。
 *
 * @module @free-lzj/dsh-mail/triage/mount
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ActionRegistry, ConditionRegistry, DecisionEngine, type EngineConnector } from '@free-lzj/dsh-decision'
import { builtinActions, mailTemplateValues, type ActionContext, type ActionOutcome, type SessionPort } from './actions/index.ts'
import { createSessionClassifier } from './classify.ts'
import { builtinConditions, type MatchContext } from './conditions.ts'
import { MAIL_VOCABULARY } from './config.ts'
import { createMailPendingStore, createMailRunStore } from './records.ts'
import { applySuggestion } from './suggest.ts'
import { labelUniverse, matches, triage, undoRun, type IncomingMail, type MatchState, type TriagePorts } from './triage.ts'
import type {
  ActionKind, ActionSpec, ConditionKind, ConditionSpec, Config, MailLike, MailSummaryLike, PendingAction,
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

/** `agents` 服务上本插件用得到的那部分。 */
interface AgentsLike {
  /** 建代理 + 会话（实测入口；旧版宿主没有这个方法）。 */
  createSession?(request: {
    readonly cwd: string
    readonly agentPreset?: string
  }): Promise<{ readonly agent: LiveAgentLike }>
}

/** 会话对象上本插件用得到的那部分。 */
interface LiveSessionLike {
  readonly id?: string
  /** 已提交的事件；`snapshotEvents` 是宿主自己的读法。 */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly { readonly type: string; readonly data?: unknown }[]
  /** 当前事件序号。 */
  readonly seq?: number
  /** 往会话里追加一个事件（改名走 `session/title`）。 */
  append?(type: string, data: unknown): unknown
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
  /**
   * 工作台持有的规则引擎。
   *
   * 装了工作台时用它——规则文件只有这一份状态；没装（或工作台太旧）时它是
   * undefined，本插件自己建一个同类的引擎。
   */
  readonly decision?: DecisionEngine
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
  /** 本插件的数据目录（`$DSH_HOME/mail`）；它的上一级就是 `$DSH_HOME`。 */
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
  /**
   * 规则状态的家。
   *
   * 与工作台的 `rulesHome()` 是同一个约定（`$DSH_HOME/dsh-console/rules`），刻意写在这里
   * 而不是从工作台那边 import：本插件不依赖工作台。共用路径是「先独跑、后装工作台」
   * 不会变成两份规则的原因——`dsh-console` 是数据位置的名字，不是本插件的实现依赖。
   */
  const home = join(dirname(deps.home), 'dsh-console', 'rules')
  /** 旧版本的规则目录：启动时按清单搬进来（只搬不删）。 */
  const legacyHomes = [join(dirname(deps.home), 'mailflow'), join(deps.home, 'triage')]

  // 两份记录：形状是邮件这一侧的，路径与引擎一致。
  const runs = createMailRunStore(join(home, 'runs.json'))
  const pending = createMailPendingStore(join(home, 'pending.json'))

  /** 现在用的引擎：工作台的，或本插件自己建的。 */
  let live: DecisionEngine | undefined
  /** 本插件自己建的引擎（没装工作台时）。 */
  let own: DecisionEngine | undefined
  /** 交给引擎的那一份连接器；只建一次——`use` 用它判别「是不是同一个连接器」。 */
  let connector: EngineConnector | undefined
  /** 分诊会话 id；回收后置空，下一次判定时重建。 */
  let classifierSessionId: string | undefined
  /** 建议处理器的注销函数；工作台没装或没有条目接口时是 undefined。 */
  let disposeSuggestion: (() => void) | undefined
  let stopping = false
  /** 已经为「工作台的引擎在别处」告过警没有：一次就够，不要每封邮件刷一行。 */
  let warnedElsewhere = false

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

  const sessionPort = (): SessionPort | undefined => buildSessionPort(ctx.get('agents') as AgentsLike | undefined)

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
      templateValues: mailTemplateValues({
        summary: input.summary,
        accountName: input.accountName,
        ruleName: input.ruleName,

        ...(input.body === undefined ? {} : { body: input.body }),
        vars: { repoRoot: config.repoRoot },
      }, config.repoRoot),
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

  /* ── 连接器：把邮件的词表、记录与重放交给引擎 ── */

  /** 发货默认规则的原文；读不到就交空串——引擎会把「默认规则坏了」显式报出来。 */
  function defaultRulesText(): string {
    try {
      return readFileSync(deps.defaultRules, 'utf8')
    } catch (error: unknown) {
      warn(`mail 分诊: 读不到内置默认规则：${describe(error)}`)
      return ''
    }
  }

  /**
   * 造这一次装载的连接器。
   *
   * 只建一次并复用：引擎用对象身份判别「是不是同一个连接器」，重建一份会让热重载
   * 把自己挡在门外。
   * @returns 连接器。
   */
  function connectorOf(): EngineConnector {
    if (connector !== undefined) return connector
    connector = {
      vocabulary: MAIL_VOCABULARY,
      defaultRules: defaultRulesText(),
      conditions: builtinConditions(),
      actions: builtinActions(),
      runs,
      pending,
      config: () => config,
      replayContext: record => replayContextFor(record as unknown as PendingAction),
      legacyHomes,
      // 试跑要走真实的匹配链路（可能问一次模型），所以由这一侧回答。
      test: async (ref) => {
        const answer = await testRule(ref.accountId, ref.folder, ref.uid)
        return 'ruleId' in answer
          ? { ok: true, result: answer }
          : { ok: false, message: answer.message ?? '试跑没有结果' }
      },
    }
    return connector
  }

  /** 重放用的动作上下文：手上只有摘要与账号（正文与当时的规则都不在了）。 */
  function replayContextFor(record: PendingAction): ActionContext {
    return actionContextFor({
      summary: record.summary,
      accountId: record.message.accountId,
      // 账号名字要在排队时记下来：`message` 里只有 id，用它当名字会让延迟执行的通知
      // 显示成一串 id。旧记录没有这个字段时退回 id，而不是空字符串。
      accountName: record.accountName ?? record.message.accountId,
      body: '',
      ruleId: record.ruleId,
      ruleName: record.ruleId,
    })
  }

  /**
   * 把规则状态交给一个引擎。
   *
   * 数据目录必须一致：不一致说明两边看到的不是同一份规则文件，那时接上去等于把状态
   * 分成两半——宁可自己另起一份，也要把话说出来。
   * @param engine - 候选引擎（通常来自 `ctx.console.decision`）。
   * @returns 是否接上了。
   */
  async function adopt(engine: DecisionEngine): Promise<boolean> {
    if (live === engine) return true
    if (engine.home !== home) {
      if (!warnedElsewhere) {
        warnedElsewhere = true
        warn(`mail 分诊: 工作台的规则目录是 ${engine.home}，与本插件的 ${home} 不一致；为免两份规则，本插件仍用自己的一份`)
      }
      return false
    }
    if (!(await engine.use(connectorOf()))) {
      warn('mail 分诊: 规则引擎已被另一个连接器占用，本插件改用自己的一份')
      return false
    }
    if (live !== engine) {
      // 先自己跑过一段、工作台才挂上来时，那份自建引擎必须停掉：同一份规则文件不能
      // 有两个实例同时在监听、同时在跑到期动作。数据留在磁盘上，不归某一次装载。
      if (own !== undefined) {
        own.stop()
        own = undefined
      }
      live = engine
    }
    return true
  }

  /**
   * 拿到这次分诊要用的引擎。
   *
   * 工作台的引擎优先；没有就自建一个同类引擎（数据目录相同，所以之后装上工作台也不会
   * 变成两份规则）。
   * @returns 引擎。
   */
  async function ensureEngine(): Promise<DecisionEngine> {
    if (live !== undefined) return live
    const shared = consoleService()?.decision
    if (shared !== undefined && await adopt(shared)) return shared
    if (own === undefined) {
      own = new DecisionEngine({ home, log, warn })
      await own.use(connectorOf())
      await own.start()
    }
    live = own
    return own
  }

  /** 当前的规则；没有引擎时是空表（引擎只认识自己的规则类型，这里收窄回邮件这一侧）。 */
  function rulesOf(): readonly Rule[] {
    const engine = live
    if (engine === undefined) return []
    return engine.rules() as readonly Rule[]
  }

  /** 引擎的注册表收窄回邮件这一侧（引擎只认识「有个 kind、能被调」）。 */
  function conditionsOf(): ConditionRegistry<ConditionSpec, MatchContext, ConditionKind> {
    return engineOf().conditions as unknown as ConditionRegistry<ConditionSpec, MatchContext, ConditionKind>
  }

  /** 同上：动作注册表。 */
  function actionsOf(): ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind> {
    return engineOf().actions as unknown as ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind>
  }

  /** 现在必须有引擎（调用点都在 `ensureEngine` 之后）。 */
  function engineOf(): DecisionEngine {
    if (live === undefined) throw new Error('规则引擎还没有就绪')
    return live
  }

  /* ── 分诊 ports ── */

  /** 每一次调用都重新读引擎，所以中途换引擎不会让分诊读到上一份状态。 */
  const portsOf = (): TriagePorts => ({
    rules: rulesOf,
    config: () => config,
    conditions: conditionsOf(),
    actions: actionsOf(),
    runs,
    pending,
    engine: {
      undo: async (runId) => {
        const result = await engineOf().undo(runId)
        return { ok: result.ok, message: result.message ?? '' }
      },
      runDue: async now => await engineOf().runDue(now),
      registerUndo: (runId, undo) => { engineOf().registerUndo(runId, undo) },
    },
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
  })

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
    const ports = portsOf()
    const state: MatchState = { labels: labelUniverse(rulesOf()), classifications: new Map() }
    for (const rule of rulesOf()) {
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

  /**
   * 本插件自己的分诊路由要的那几个操作。
   *
   * 规则状态归引擎，所以除了「试跑」之外都是转交；留着这组路由是因为邮件插件要能在
   * 没有工作台的部署里被调用（工作台那一页读的是 `/dsh-console/rules/*`，同一份状态）。
   */
  const routes: TriageRouteHost = {
    rules: async (): Promise<RulesView> => {
      const view = engineOf().view()
      return {
        rules: view.rules as readonly Rule[],
        ...(view.error === undefined ? {} : { error: view.error }),
        source: view.source,
        path: view.path,
        raw: view.raw,
        dropped: view.dropped,
        config,
      }
    },
    setEnabled: async (ruleId, enabled) => await engineOf().setEnabled(ruleId, enabled),
    setMode: async (ruleId, actionIndex, mode) => await engineOf().setMode(ruleId, actionIndex, mode),
    setCondition: async (ruleId, conditionIndex, values) =>
      await engineOf().setConditionValues(ruleId, conditionIndex, values),
    movePriority: async (ruleId, direction) => await engineOf().movePriority(ruleId, direction),
    runs: async since => ({ runs: engineOf().listRuns(since ?? undefined) as readonly Run[] }),
    undo: async runId => await undoRun(runId, portsOf()),
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
    await applySuggestion(item, actionId, { pending, actions: actionsOf(), runs, ports: portsOf() })
  }

  /**
   * 读状态、读规则、开始监听规则文件，并把建议点击接到工作台上。
   *
   * 返回的 promise 在「规则已可用」之后才 resolve，所以宿主与测试都不必猜时间点；
   * 失败只记日志、不 reject——读不到规则的分诊应当安静降级，而不是让插件起不来。
   */
  function start(): Promise<void> {
    return (async () => {
      await ensureEngine()
      if (stopping) return
      // 工作台的引擎可能比本插件晚挂载：它一出现就把规则交过去，免得同一份文件被
      // 两个实例读（`rules/design-patterns.md`：服务出现时要跟随，不能只判断一次）。
      ctx.inject(['console'], (inner) => {
        inner.effect(() => {
          const shared = (inner.get('console') as ConsoleLike | undefined)?.decision
          if (shared !== undefined) {
            void adopt(shared).catch((error: unknown) => warn(`mail 分诊: 接入工作台引擎失败：${describe(error)}`))
          }
          return () => {
            // 本插件卸载时把词表从工作台的引擎上摘下来；规则文件留在磁盘上。
            if (live !== undefined && live !== own) live.unuse()
          }
        }, 'mail: hand triage rules to the workbench')
      })
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
    disposeSuggestion?.()
    if (live !== undefined && live !== own) live.unuse()
    own?.stop()
  }

  return {
    config,
    routes,
    triage: async mail => await triage(mail, portsOf()),
    start,
    stop,
  }
}

/** 描述任意抛出物。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/** 本插件建过的会话，用来给改名与投话找到那只 agent。 */
const triageAgents = new Map<string, LiveAgentLike>()

/**
 * 会话端口。
 *
 * 服务名是**实测过的**（`docs/workbench-session-api.md`）：宿主给的是 `agents`，它上面
 * 的 `createSession({cwd})` 是唯一同时建出代理与会话的入口；改名是往会话里追加一个
 * `session/title` 事件；投话走 `agent.followup`。这里以前按 `sessionController` /
 * `workspaceRegistry` 拼，那两个名字在宿主里不存在，所以整条会话动作从来没跑起来过。
 *
 * 老接口里的「挂工作区」「挂权限」这一版没有对应动词：目录在建会话时就带上了，权限是
 * 会话上的 `permission/*` 事件、动作层只有 id——两处都按**空实现**处理，而不是假装做过了。
 * @param agents - 宿主的 `agents` 服务，可能不存在或没有建会话能力。
 * @returns 端口；宿主不给建会话能力时 undefined，动作层据此回答「没有会话服务」。
 */
export function buildSessionPort(agents: AgentsLike | undefined): SessionPort | undefined {
  const createSession = agents?.createSession
  if (createSession === undefined) return undefined
  return {
    createSession: async request => {
      const { agent } = await createSession.call(agents, request)
      const sessionId = agent.session?.id
      if (sessionId === undefined) throw new Error('the created agent reported no session id')
      triageAgents.set(sessionId, agent)
      return { sessionId }
    },
    attachSession: async (cwd, sessionId) => {
      // 目录随 `createSession({cwd})` 一起进会话 header，这一版没有单独的挂载动词。
      void cwd
      void sessionId
    },
    rename: async (sessionId, title) => {
      triageAgents.get(sessionId)?.session?.append?.('session/title', {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    },
    setPermission: (sessionId, preset) => {
      // 权限是会话上的 `permission/*` 事件，而动作层只有 id；这一版不假装挂上。
      void sessionId
      void preset
    },
    followup: async (sessionId, text, source) => {
      const agent = triageAgents.get(sessionId)
      if (agent === undefined) throw new Error(`session "${sessionId}" was not created by this plugin`)
      agent.followup({ role: 'user', content: [{ type: 'text', text }], source })
    },
  }
}
