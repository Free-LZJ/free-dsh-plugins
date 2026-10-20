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
