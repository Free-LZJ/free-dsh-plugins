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

/** One notice a plugin hands to the workbench. */
export interface ConsoleNotice {
  /** Short headline, already localized by the caller. */
  readonly title: string
  /** Optional supporting sentence. */
  readonly body?: string
  /** Defaults to `info`. */
  readonly tone?: NoticeTone
  /** Panel or plugin id the notice is about; shown as the source line. */
  readonly source?: string
}

/** One delivered notice, with the identity and instant the workbench gave it. */
export interface ConsoleNoticeRecord extends ConsoleNotice {
  readonly id: string
  readonly createdAt: number
  /** Channels that actually delivered it, in enabled order. */
  readonly delivered: readonly string[]
}

/** One notification channel as the settings row and the Host describe it. */
export interface ChannelInfo {
  readonly id: string
  /** Whether the channel is currently switched on by the saved configuration. */
  readonly enabled: boolean
}

/** Per-user view preferences the workbench persists on the Host. */
export type ConsoleLayout = 'grid' | 'list' | 'compact'

/**
 * Everything the browser cannot derive: the notices, the channels, and the one
 * stored preference. The panel list is the browser's own to render.
 */
export interface ConsoleState {
  readonly notices: readonly ConsoleNoticeRecord[]
  /** Channels the Host implements, in the order the settings row lists them. */
  readonly availableChannels: readonly ChannelInfo[]
  /** The view the user last saved. */
  readonly layout: ConsoleLayout
  /** Panel ids the user pinned, in the order they were pinned. */
  readonly pinned: readonly string[]
  readonly revision: number
}

/** Names of the channels this package ships; the configuration selects among them. */
export const BUILTIN_CHANNELS = ['desktop', 'inapp', 'sound'] as const

/** Client-service name every adopting plugin injects. */
export const CONSOLE_SERVICE = 'console'

/** Main-panel key (and sidebar entry id) the workbench shell occupies. */
export const CONSOLE_PANEL_ID = 'console'

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
  /** Why, in the classifier's own words; shown on the card. */
  readonly reasons: readonly string[]
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
  /** Why, in routing's own words; shown on the card. */
  readonly reasons: readonly string[]
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
