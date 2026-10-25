/**
 * The workbench's Host half: the service every other plugin talks to.
 *
 * One class owns the things a home surface cannot keep in a browser tab — the
 * notices, the channel set, and the two preferences that must survive a reload —
 * because they share a single revision: a list that changed without the notice
 * list knowing is a list that renders twice.
 *
 * Two rules shape the file.
 *
 * 1. **`notify()` is `await`-able and never rejects.** A plugin handing over a
 *    notice cannot fail because a channel is unavailable; the notice is stored
 *    first, then each enabled channel is given its chance, and a channel that
 *    throws only loses its own delivery.
 * 2. **Channels are strategies, not switches.** The dispatcher walks whatever
 *    the registry holds and consults `plan()`; the *set* of channels is an
 *    implementation detail registered at mount time, and the *enabled* subset is
 *    configuration. Adding a fourth way to tell the user touches neither the
 *    dispatcher nor this class.
 *
 * The panel list is deliberately absent: a panel is declared by its own plugin's
 * browser half, so only the browser can render it. What the Host keeps about
 * panels is one id list — pinned — and nothing else.
 *
 * @module @free-lzj/dsh-console/console-host
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { PresenceGate } from './builtin-channels.ts'
import { ChannelRegistry, type NoticeDelivery } from './channels.ts'
import type {
  ChannelInfo, ConsoleLayout, ConsoleNotice, ConsoleNoticeRecord, ConsoleState, NoticeTone,
  WorkbenchEvent,
} from './protocol.ts'
import { emptyPrefs, readPrefs, writePrefs, type ConsolePrefs } from './store.ts'
import type { IngestResult, WorkbenchBoard } from './workbench/board.ts'

/** The most notices kept for one browser session. */
export const NOTICE_LIMIT = 50

/** One event pushed to every open workbench. */
export type ConsoleEvent =
  | { readonly type: 'state'; readonly state: ConsoleState }
  | { readonly type: 'notice'; readonly notice: ConsoleNoticeRecord; readonly delivered: readonly string[] }

/** Everything the service needs from its owner, injected so tests can drive it without files. */
export interface ConsoleHostOptions {
  /** The harness home directory the preferences document lives below. */
  readonly homeDir: string
  /** Which channel ids the saved configuration switches on. */
  readonly channels: () => readonly string[]
  /** The saved view preference. */
  readonly layout: () => ConsoleLayout
}

/** Normalize a caller-supplied tone, defaulting to `info`. */
function toneOf(value: NoticeTone | undefined): NoticeTone {
  return value === 'success' || value === 'warn' || value === 'error' ? value : 'info'
}

/**
 * The `ctx.console` service.
 *
 * Plugins reach it as `ctx.console` by declaring it in their `inject` and hand it
 * a notice; the browser half reaches the same service through
 * {@link ./client/contract consoleService} for the two preferences.
 */
export class ConsoleHost extends Service {
  private readonly registry = new ChannelRegistry()
  private readonly listeners = new Set<(event: ConsoleEvent) => void>()
  private readonly notices: ConsoleNoticeRecord[] = []
  /** Browsers currently streaming events; the channels that need a page consult it. */
  readonly presence = new PresenceGate()
  private prefs: ConsolePrefs = emptyPrefs()
  private layout: ConsoleLayout
  private revision = 0
  /** The board this service fronts for companion plugins; set by the plugin's mount. */
  private board: WorkbenchBoard | undefined
  /**
   * Settles once the saved preferences were read (or found absent).
   *
   * Published because the read is asynchronous while the first request is not:
   * a caller that cares about showing the user's own pins on the very first
   * paint awaits this, and a spec gets a deterministic moment instead of a race.
   * Every writer awaits it too — a click that landed before the read must merge
   * onto what the file said, not overwrite it with a half-empty document.
   */
  readonly ready: Promise<void>

  /**
   * @param ctx - the providing plugin's context (the service unloads with it).
   * @param options - the filesystem location and the live configuration readers.
   */
  constructor(ctx: Context, private readonly options: ConsoleHostOptions) {
    super(ctx, 'console')
    this.layout = options.layout()
    this.ready = readPrefs(options.homeDir).then((saved) => {
      this.prefs = saved
      this.bump()
    })
  }

  /** The channels this package implements, before configuration. */
  get channels(): ChannelRegistry {
    return this.registry
  }

  /**
   * Hand a notice to the workbench.
   *
   * Stores it, then offers it to every enabled channel in registration order.
   * Never rejects: a channel's failure is logged and reported as "not delivered
   * by that channel", and the notice stays in the centre regardless.
   * @param notice - what to tell the user.
   * @returns the stored record.
   */
  async notify(notice: ConsoleNotice): Promise<ConsoleNoticeRecord> {
    const title = typeof notice?.title === 'string' ? notice.title.trim() : ''
    if (title === '') throw new TypeError('console.notify: a notice needs a non-empty title')
    const envelope: NoticeDelivery = {
      id: randomUUID(),
      title,
      ...(notice.body === undefined ? {} : { body: notice.body }),
      tone: toneOf(notice.tone),
      ...(notice.source === undefined ? {} : { source: notice.source }),
      createdAt: Date.now(),
    }
    const delivered: string[] = []
    for (const id of this.options.channels()) {
      const channel = this.registry.get(id)
      if (channel === undefined || !channel.plan(envelope)) continue
      try {
        if (await channel.deliver(envelope)) delivered.push(id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`console: channel "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const record: ConsoleNoticeRecord = { ...envelope, delivered }
    this.notices.unshift(record)
    if (this.notices.length > NOTICE_LIMIT) this.notices.length = NOTICE_LIMIT
    this.bump({ type: 'notice', notice: record, delivered })
    return record
  }

  /**
   * Attach the board this service fronts.
   *
   * The board is assembled by the plugin's mount, not by this class, so a
   * companion plugin that only needs `notify()` never pays for it — and a
   * test can drive this class without a board at all.
   * @param board - the board.
   */
  attachWorkbench(board: WorkbenchBoard): void {
    this.board = board
  }

  /**
   * Hand one inbound work event to the board — the mail connector's entrance
   * for a companion plugin, and the shape the webhook entrance normalizes to.
   *
   * A caller probes for this method rather than assuming it: a workbench
   * without a board (or an older one) answers `ok: false`, and the caller
   * keeps its own behavior instead of failing.
   * @param event - the normalized inbound event.
   * @returns the ingest result, or why there is no board to take it.
   */
  ingestWorkbenchEvent(event: WorkbenchEvent): Promise<IngestResult> {
    if (this.board === undefined) return Promise.resolve({ ok: false, error: 'the workbench board is not mounted' })
    return this.board.ingest(event)
  }

  /** Forget the notices of this session (the user dismissed the list). */
  clearNotices(): void {
    if (this.notices.length === 0) return
    this.notices.length = 0
    this.bump()
  }

  /**
   * Read the whole state.
   * @returns the state the browser's home list and notice centre render from.
   */
  state(): ConsoleState {
    return {
      notices: this.notices,
      availableChannels: this.channelInfos(),
      layout: this.layout,
      pinned: this.prefs.pinned,
      revision: this.revision,
    }
  }

  /**
   * Pin or unpin one panel.
   * @param id - panel id.
   * @param pinned - wanted pin state.
   */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.ready
    const next = this.prefs.pinned.filter((entry) => entry !== id)
    if (pinned) next.push(id)
    await this.save({ ...this.prefs, pinned: next })
  }

  /**
   * Subscribe to state pushes.
   * @param listener - receives every event; called synchronously.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (event: ConsoleEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Announce that something the browser draws changed without this class knowing why. */
  changed(): void {
    this.bump()
  }

  /**
   * Follow a live configuration change (the Loader row is re-applied).
   * @param layout - the new saved layout.
   */
  applyConfig(layout: ConsoleLayout): void {
    this.layout = layout
    this.bump()
  }

  /**
   * Channel availability for the settings row and the dispatcher.
   * @returns every registered channel with its configured state.
   */
  private channelInfos(): ChannelInfo[] {
    const enabled = this.options.channels()
    return this.registry.list().map((channel) => ({
      id: channel.id,
      enabled: enabled.includes(channel.id),
    }))
  }

  /**
   * Persist the preferences document, then tell every open workbench.
   * @param next - the document to save.
   */
  private async save(next: ConsolePrefs): Promise<void> {
    this.prefs = next
    this.bump()
    try {
      await writePrefs(this.options.homeDir, next)
    } catch (error: unknown) {
      this.ctx.logger.warn(`console: saving preferences failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Advance the revision and push the new state (or the event that changed it). */
  private bump(event?: ConsoleEvent): void {
    this.revision += 1
    const payload = event ?? { type: 'state', state: this.state() }
    for (const listener of [...this.listeners]) {
      try {
        listener(payload)
      } catch (error: unknown) {
        this.ctx.logger.warn(`console: event listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** @returns the current preferences, for tests and the routes. */
  preferences(): ConsolePrefs {
    return this.prefs
  }
}
