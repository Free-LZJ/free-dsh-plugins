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

/** Per-user view preferences the workbench persists on the Host. */
export type ConsoleLayout = 'grid' | 'list' | 'compact'

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
