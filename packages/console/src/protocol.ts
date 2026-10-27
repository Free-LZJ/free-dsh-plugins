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
  /** Session this item is about, so a UI can point at where the work happens. */
  readonly sessionId?: string
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
 * One of the five views the workbench navigation switches between.
 *
 * Four are pages inside `main:console`; `focus` is its own main panel
 * ({@link CONSOLE_FOCUS_PANEL_ID}), because in DSH's terms a page is one keyed
 * entry in the `main` slot — so reaching it is a `layout.selectPanel` call, not
 * a state flip.
 */
export type ConsoleView = 'board' | 'rules' | 'focus' | 'connectors' | 'apps'

/** The five views, in navigation order. */
export const CONSOLE_VIEWS: readonly ConsoleView[] = ['board', 'rules', 'focus', 'connectors', 'apps']

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

/** One connector as the board and the settings surface describe it. */
export interface WorkbenchConnectorInfo {
  readonly id: string
  readonly label: string
  /** Which directions this connector carries. */
  readonly directions: readonly ('in' | 'out')[]
  /** Whether the configuration switches it on. */
  readonly enabled: boolean
  /**
   * Whether the entrance actually works in this build. A placeholder connector
   * (DingTalk, Jira) is listed and configurable but sends no real request.
   */
  readonly implemented: boolean
  /** What it does today, and what it deliberately does not. */
  readonly note?: string
}

/** Everything the browser cannot derive about the board. */
export interface WorkbenchState {
  readonly cards: readonly WorkbenchCard[]
  readonly sessions: readonly WorkbenchSession[]
  readonly connectors: readonly WorkbenchConnectorInfo[]
  /** Version of the routing table the current decisions were made with. */
  readonly routingVersion: string
  readonly revision: number
}
