/**
 * The workbench's own vocabulary: what crosses the wire between its two halves.
 *
 * Imported by both halves — types only — so one declaration keeps the Host and
 * the browser in step. Keep it free of `node:*`, of React, and of anything from
 * either half's runtime.
 *
 * Note what is **not** here: the panel list. Panels are declared by their own
 * plugin's browser half, so the browser is the only side that knows their
 * titles, descriptions and icons — it renders them. The Host owns what the
 * browser cannot: the delivered notices, which channels exist, and the one
 * stored preference. `pinned` is therefore a plain id list here, not panel
 * objects.
 *
 * @module @free-lzj/dsh-console/protocol
 */

/** How stern a notice is; channels and the notification centre style it alike. */
export type NoticeTone = 'info' | 'success' | 'warn' | 'error'

/**
 * One thing the user can do about an item.
 *
 * An action carries **no behaviour**: the workbench only knows its id and label, and
 * routes the click back to the plugin that raised the item (see `kind`). That keeps
 * the workbench from knowing what any plugin means by "执行".
 */
export interface NoticeAction {
  /** Stable id the raising plugin recognises. */
  readonly id: string
  /** Already-localized label. */
  readonly label: string
  /** `danger` paints it as the destructive choice. */
  readonly style?: 'primary' | 'danger'
}

/**
 * Where an item is in its life.
 *
 * The three that matter for a work desk: `new` (nobody has looked), `resolved`
 * (the user picked an action and the plugin did it), `dismissed` (the user said
 * "not my problem"). `seen` exists so a queue can be honest about what has been
 * looked at without being handled.
 */
export type NoticeState = 'new' | 'seen' | 'resolved' | 'dismissed'

/**
 * One item a plugin hands to the workbench.
 *
 * A notice and an item are the same object at different strengths: a bare `title`
 * is a notice (nothing to do), while `actions` turns it into something the user can
 * decide on. That is why `notify` and `raise` share one shape and one store.
 */
export interface ConsoleNotice {
  /** Short headline, already localized by the caller. */
  readonly title: string
  /** Optional supporting sentence. */
  readonly body?: string
  /** Defaults to `info`. */
  readonly tone?: NoticeTone
  /** Panel or plugin id the notice is about; shown as the source line. */
  readonly source?: string
  /**
   * Which plugin raised it, and therefore whose action handler runs when the user
   * clicks. Omitted on a plain notice (it has nothing to act on).
   */
  readonly kind?: string
  /** What the user can do about it. Omitted = there is nothing to do. */
  readonly actions?: readonly NoticeAction[]
  /**
   * 这件事在源头的地址：GitHub 的 run、Jira 的工单、邮件本身。
   *
   * 一个裸 URL 而不是 `NoticeAction`：点它是**跳出去看**，不改变任何状态，所以不必
   * 经过插件的动作路由，点完条目也不该变成 `resolved`。
   */
  readonly link?: string
  /** Session this item is about, so a UI can point at where the work happens. */
  readonly sessionId?: string
  /**
   * 这条通知属于哪条链路（同一件事的根卡 id）。
   *
   * 工作台把一次派生出来的卡片和通知按这个键收成一条链，详情里按顺序展示。
   * 不给时 Host 会按 `sessionId` 自己找；找不到就自成一链。
   */
  readonly rootId?: string
}

/** One delivered notice, with the identity and instant the workbench gave it. */
export interface ConsoleNoticeRecord extends ConsoleNotice {
  readonly id: string
  readonly createdAt: number
  /** Channels that actually delivered it, in enabled order. */
  readonly delivered: readonly string[]
  readonly state: NoticeState
  /** Which action the user picked, once they did. */
  readonly resolvedAction?: string
  /** Epoch ms until which this item stays out of the queue. */
  readonly snoozedUntil?: number
}

/** One notification channel as the settings row and the Host describe it. */
export interface ChannelInfo {
  readonly id: string
  /** Whether the channel is currently switched on by the saved configuration. */
  readonly enabled: boolean
}

/**
 * One session that is working right now.
 *
 * The point of the workbench showing these is trust: an agent that runs on your behalf
 * while you are not watching has to be visible somewhere, or you cannot leave it alone.
 * Deliberately minimal — an id, a title, where it runs — because anything more is a
 * session browser, which is a different screen.
 */
export interface RunningSession {
  readonly sessionId: string
  readonly title: string
  /** Working directory the session runs in, as the Host reports it. */
  readonly cwd?: string
}

/** Per-user layout preference for the plugin directory. */
export type ConsoleLayout = 'grid' | 'list' | 'compact'

/**
 * One of the six views the workbench navigation switches between.
 *
 * Five are pages inside `main:console`; `focus` is its own main panel
 * ({@link CONSOLE_FOCUS_PANEL_ID}), because in DSH's terms a page is one keyed
 * entry in the `main` slot — so reaching it is a `layout.selectPanel` call, not
 * a state flip.
 *
 * `notify` exists because a board that shows what happened and a queue that
 * shows what wants an answer are two different questions. They used to share
 * one page, so the queue crowded the board and the board buried the queue.
 */
export type ConsoleView = 'board' | 'notify' | 'rules' | 'focus' | 'connectors' | 'apps'

/** The six views, in navigation order. */
export const CONSOLE_VIEWS: readonly ConsoleView[] = ['board', 'notify', 'rules', 'focus', 'connectors', 'apps']

/**
 * 归档节奏：一个任务走完以后多久离开看板。
 *
 * 这是**展示策略**，不是数据生命周期——记录永远留在 `runs.json` 里，
 * 变的只是它还占不占板面。所以它属于偏好而不是配置项里的能力开关。
 */
export type ArchiveRhythm = 'immediate' | 'fifteen' | 'hour' | 'day'

/** 可选的归档节奏，按界面上的顺序。 */
export const ARCHIVE_RHYTHMS: readonly ArchiveRhythm[] = ['immediate', 'fifteen', 'hour', 'day']

/**
 * 一档归档节奏对应的毫秒数：任务最后一次活动过去这么久就进归档。
 *
 * `immediate` 是 0——走完当场归档，板面只留还在动的东西。
 */
export const ARCHIVE_RHYTHM_MS: Readonly<Record<ArchiveRhythm, number>> = {
  immediate: 0,
  fifteen: 15 * 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
}

/**
 * One thing an automation did on its own.
 *
 * Deliberately **not** a queue item: a plugin that files away twenty promotions a day
 * would drown the attention queue in things nobody needs to decide. This is a log —
 * capped, low-key, and read only when someone asks "what has it been doing".
 */
export interface ConsoleLogEntry {
  readonly id: string
  /** Epoch ms. */
  readonly at: number
  /** Who did it (`mailflow`, `tasks`, …). */
  readonly source: string
  /** One line: what it did. */
  readonly title: string
  /** Optional second line: on what, or why it failed. */
  readonly detail?: string
  /** False when the automation tried and failed — the log must not read as success. */
  readonly ok: boolean
}

/**
 * Everything the browser cannot derive: the items, the channels, and the one
 * stored preference. The panel list is the browser's own to render.
 */
export interface ConsoleState {
  readonly notices: readonly ConsoleNoticeRecord[]
  /**
   * How many items are still waiting on the user (state `new`, not snoozed).
   *
   * Sent as a number rather than left for the browser to count: it is the one figure
   * a work desk shows on every screen, and it must not depend on the browser having
   * the whole list.
   */
  readonly awaiting: number
  /** Channels the Host implements, in the order the settings row lists them. */
  readonly availableChannels: readonly ChannelInfo[]
  /** The view the user last saved. */
  readonly layout: ConsoleLayout
  /**
   * 任务走完之后多久离开看板。
   *
   * Host 持有而不是页面自己存：它和 `layout` 一样是一份跟着用户走的偏好，
   * 换个标签页打开应该看到同一档节奏。
   */
  readonly archiveRhythm: ArchiveRhythm
  /**
   * The view the workbench was last showing.
   *
   * The layout's own selection is memory-only (`ui-layout` persists nothing), so a
   * reload lands back on the conversation; this is what the workbench reads to
   * reopen the page the user left.
   */
  readonly currentView: ConsoleView
  /** Panel ids the user pinned, in the order they were pinned. */
  readonly pinned: readonly string[]
  /**
   * Sessions working right now, as of the last refresh.
   *
   * Carried in the state rather than fetched by the page so a workbench opened from a
   * second tab shows the same picture, and so a deployment without a session service
   * simply reports none.
   */
  readonly running: readonly RunningSession[]
  /** What automations did on their own, newest first, capped. */
  readonly log: readonly ConsoleLogEntry[]
  readonly revision: number
}

/** Names of the channels this package ships; the configuration selects among them. */
export const BUILTIN_CHANNELS = ['desktop', 'inapp', 'sound'] as const

/** Client-service name every adopting plugin injects. */
export const CONSOLE_SERVICE = 'console'

/** Main-panel key (and sidebar entry id) the workbench shell occupies. */
export const CONSOLE_PANEL_ID = 'console'

/**
 * Main-panel key of the focus page — the workbench's second page.
 *
 * A separate keyed entry rather than a state inside `console`, so switching to
 * it is a real page navigation (`ctx.layout.selectPanel`) and the two pages each
 * own their content, exactly as the design brief asked (decision Q1).
 */
export const CONSOLE_FOCUS_PANEL_ID = 'console-focus'

/**
 * The workbench board's vocabulary: what crosses the wire between its two
 * halves. Same rule as above — types only, no `node:*`, no React, nothing from
 * either half's runtime — so the Host and the browser stay in step.
 *
 * What is **not** here, on purpose: any diff-review gate. The user shelved diff
 * review for v0, so a finished card lands in `done` with
 * `awaitingConfirmation` set and no write-back happens until a later decision
 * says otherwise. A card's `decision` is the audit trail: which rule version
 * and which classification routed it, so a routing change can be replayed
 * against the same events.
 *
 * @module @free-lzj/dsh-console/protocol/workbench
 */

/** Which outside system an inbound work event came from. */
export type WorkbenchSource = 'mail' | 'webhook' | 'dingtalk' | 'jira' | 'manual'

/** How urgently a card wants attention; the classifier derives it, the board renders it. */
export type WorkbenchPriority = 'low' | 'normal' | 'high' | 'urgent'

/** The three columns of the board. */
export type WorkbenchColumn = 'todo' | 'processing' | 'done'

/** What a card is doing, rendered on the card itself. */
export type WorkbenchCardStatus = 'idle' | 'running' | 'waiting-input' | 'paused' | 'done' | 'failed'

/** What a session is doing, rendered in the focus view. */
export type WorkbenchSessionStatus = 'running' | 'paused' | 'done' | 'failed' | 'ended'

/** One inbound work event: a connector's trigger, normalized. */
export interface WorkbenchEvent {
  /** The connector the event arrived through. */
  readonly source: WorkbenchSource
  /** The source system's own id, when it has one; the dedupe key with `source`. */
  readonly externalId?: string
  /** Short headline, already trimmed by the caller. */
  readonly title: string
  /** Supporting text, used by the classifier. */
  readonly body?: string
  /**
   * 这件事的根卡 id：同一件事派生出来的后续事件（子会话、子派单）带上它，
   * 看板就把它们合并成一张卡。不给时这张卡自成一链。
   */
  readonly rootId?: string
}

/**
 * One line of a card's audit trail.
 *
 * The Host says **what happened** (`code` + `params`); the page says **how to
 * word it**, through its own locales. A pre-rendered `text` only exists for cards
 * written by an older build, where the Host spelled the sentence out — showing
 * that is better than dropping the line.
 */
export interface WorkbenchReason {
  /** Machine-readable id; the page renders the locale key registered for it. */
  readonly code: string
  /** Values the sentence needs (a kind, a count, an executor id). */
  readonly params?: Readonly<Record<string, string | number>>
  /** Sentence from an older build; shown when the page does not know `code`. */
  readonly text?: string
}

/** What the classification core decided about one event. */
export interface WorkbenchClassification {
  /** Task kind: `bug`, `requirement`, `consult`, or `unknown`. */
  readonly kind: string
  /** Project the event looks like it belongs to, when one could be read off it. */
  readonly project?: string
  readonly priority: WorkbenchPriority
  /** Executor the classification suggests, when it has an opinion. */
  readonly executor?: string
  /** 0–1; below the routing threshold the card is held for a human. */
  readonly confidence: number
  /** Why, as codes the page words; shown on the card. */
  readonly reasons: readonly WorkbenchReason[]
}

/** What routing does with a classified event. */
export type WorkbenchAction = 'dispatch' | 'hold' | 'reply-only'

/** The auditable routing decision stored on every card. */
export interface RoutingDecision {
  readonly action: WorkbenchAction
  /** Executor the decision routes to, when it dispatches. */
  readonly executor?: string
  /** Id of the routing-table rule that matched, or the fallback name. */
  readonly routeId: string
  /** Version of the routing table that decided. */
  readonly ruleVersion: string
  readonly classification: WorkbenchClassification
  /** Why, as codes the page words; shown on the card. */
  readonly reasons: readonly WorkbenchReason[]
}

/** One card on the board. */
export interface WorkbenchCard {
  readonly id: string
  readonly source: WorkbenchSource
  readonly externalId?: string
  /** `source:externalId`, or `source:title:…` when the source has no id. */
  readonly dedupeKey: string
  /**
   * 同一件事的根卡 id；等于自己的 `id` 时这张卡就是链路的起点。
   *
   * 看板按它分组：一张链路卡展开是「创建 → 派单 → 子会话 → 子派单 → 完成」，
   * 而不是五张互不相干的卡。
   */
  readonly rootId: string
  /**
   * 这条链是**推断**出来的（标题相似 + 时间相近），不是调用方声明的。
   *
   * 存量卡没有根，不推断就永远是散卡；推断就可能合错，所以界面要说清并给「拆开」。
   */
  readonly chainInferred?: boolean
  /** 用户把这个成员从推断出来的链里拆开过：下次启动别再把它推回去。 */
  readonly chainDetached?: boolean
  readonly title: string
  readonly body?: string
  readonly column: WorkbenchColumn
  readonly status: WorkbenchCardStatus
  readonly priority: WorkbenchPriority
  readonly kind: string
  /** The classification confidence that routed it. */
  readonly confidence: number
  readonly executor?: string
  readonly sessionId?: string
  /** True once work finished and the result waits for a human before any write-back. */
  readonly awaitingConfirmation: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly decision: RoutingDecision
}

/** One log line of a session. */
export interface WorkbenchLogLine {
  readonly at: number
  readonly text: string
}

/**
 * New session log lines since the page's cursor.
 *
 * Sent when the board's structure did not move but a running session printed
 * more: the poll then costs the new lines only, not the whole document. The page
 * sends the newest `at` it already has as `logsSince`.
 */
export interface WorkbenchLogDelta {
  readonly revision: number
  readonly logs: readonly {
    readonly sessionId: string
    readonly lines: readonly WorkbenchLogLine[]
  }[]
}

/** One agent session, focused in the session view. */
export interface WorkbenchSession {
  readonly id: string
  readonly cardId: string
  readonly executor: string
  readonly status: WorkbenchSessionStatus
  readonly logs: readonly WorkbenchLogLine[]
  readonly createdAt: number
  readonly updatedAt: number
}



/**
 * 任务与节点：工作台看板读的那份真相。
 *
 * 与 `@free-lzj/dsh-decision` 的 `Task` 逐字段对应，但**故意复制一份**：那个包是
 * Node 库（读文件、跑链），浏览器半边不能 import 它。两份定义靠这一句约定绑住：
 * 改任何一个字段，两边一起改，否则看板会静默少一列。
 */

/** 一条任务走到哪了。 */
export type TaskStatus = 'running' | 'done' | 'partial' | 'skipped' | 'failed' | 'undone'

/** 链上的一格。 */
export interface TaskNodeRecord {
  readonly id: string
  /** `trigger` | `classify` | `rule` | 动作 kind | `session`。 */
  readonly kind: string
  /**
   * 它在事件流图上是哪个节点；旧链式任务没有。
   *
   * 看板靠这一对把执行记录贴回画布：`flowId` 决定画哪张图（子工作流不一样），
   * `nodeId` 决定点亮哪一个方块。
   */
  readonly nodeId?: string
  readonly flowId?: string
  readonly at: string
  readonly ok: boolean
  readonly detail: string
  readonly failure?: 'config' | 'transient' | 'fatal'
  readonly actionIndex?: number
  /** 只有会话节点（与建了会话的动作）才有。 */
  readonly sessionId?: string
  /**
   * 这是哪一轮的记录。
   *
   * 同一个任务会重跑（重试、追问），记录全留在 `nodes` 里；画布点亮只看本轮，
   * 否则上一轮的失败会一直红着。旧记录没有这个字段，按「都算」处理。
   */
  readonly runId?: string
  readonly data?: Readonly<Record<string, unknown>>
}

/**
 * 一次执行走到哪了。
 *
 * 节点图执行器的 `FlowProgress` 在页面这一侧的最小投影：页面只需要知道
 * 「哪些已经跑过、正在跑哪一格、下一步是哪一格、卡在哪一格」，其余字段
 * （满足的边、等多久、挂起几次）由引擎自己用，不必过桥。
 */
export interface TaskProgress {
  readonly done: readonly string[]
  readonly satisfied: readonly string[]
  /** 下一次要跑的节点 id。 */
  readonly ready: readonly string[]
  /** 已经交给节点、还没返回的那几个。 */
  readonly running?: readonly string[]
  /** 挂在这个节点上等外部结果。 */
  readonly suspendedAt?: string
}

/** 一个任务：一个事件被触发器选中后的整条链。 */
export interface Task {
  readonly id: string
  readonly connector: string
  readonly triggerId: string
  readonly key: string
  readonly eventKey?: string
  readonly title: string
  readonly at: string
  readonly updatedAt: string
  readonly status: TaskStatus
  readonly nodes: readonly TaskNodeRecord[]
  /** 这一轮的执行进度；跑完且没有后续时缺省。 */
  readonly progress?: TaskProgress
  /** 这一轮的事件与上游出参，节点配置里的 `{键}` 就查它。 */
  readonly vars?: Readonly<Record<string, string>>
  /** 这一轮的 id；节点记录上的 `runId` 指向它。 */
  readonly runId?: string
  readonly awaitingConfirmation?: boolean
  readonly acknowledged?: boolean
  readonly undoableUntil?: string
}

/**
 * 「这条任务在别处长什么样」——连接器用自己的面板接手它时需要的最小身份。
 *
 * 不给整条任务：别的插件的面板只该知道「跟进哪一个东西」，不该拿到执行记录。
 */
export interface TaskJump {
  readonly connector: string
  /** 连接器给的任务身份；邮件就是 `mail:{账号}:{目录}:{uid}`。 */
  readonly key: string
}

/** 一个连接器在看板上长什么样。 */
export interface TaskConnectorInfo {
  readonly id: string
  readonly label: string
  readonly directions: readonly ('in' | 'out')[]
  readonly implemented: boolean
  readonly note?: string
  /** 它参不参与规则；关掉只停规则，不卸载插件。 */
  readonly enabled: boolean
  readonly triggers: readonly string[]
  readonly actions: readonly string[]
}

/** Everything the browser cannot derive about the board. */
export interface WorkbenchState {
  /** 看板的真相：每个任务是一条节点链。 */
  readonly tasks: readonly Task[]
  /** 已废弃（旧卡片管线）：留着字段是为了旧页面不炸，值恒为空。 */
  readonly cards: readonly WorkbenchCard[]
  readonly sessions: readonly WorkbenchSession[]
  readonly connectors: readonly TaskConnectorInfo[]
  readonly revision: number
}
