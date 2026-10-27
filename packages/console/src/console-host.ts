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
  ChannelInfo, ConsoleLayout, ConsoleLogEntry, ConsoleNotice, ConsoleNoticeRecord, ConsoleState, ConsoleView, NoticeTone,
  RunningSession, WorkbenchEvent,
} from './protocol.ts'
import { emptyPrefs, readPrefs, writePrefs, type ConsolePrefs } from './store.ts'
import type { IngestResult, WorkbenchBoard } from './workbench/board.ts'

/** The most notices kept for one browser session. */
export const NOTICE_LIMIT = 50

/**
 * How many automation log entries are kept.
 *
 * Small on purpose: the log answers "what has it been doing lately", and past a hundred
 * lines nobody reads it. It is not an audit trail — that lives in the plugin that did
 * the work (the mail plugin keeps its own run history).
 */
export const LOG_LIMIT = 100

/** The view a profile that never navigated opens on. */
export const DEFAULT_VIEW: ConsoleView = 'board'

/**
 * What a plugin does when the user picks one of its item's actions.
 *
 * The workbench deliberately knows nothing about what an action means: it hands the
 * item and the action id back to whoever raised it. A handler that throws loses only
 * its own click — the item stays in the queue with the reason attached.
 */
export type NoticeActionHandler = (item: ConsoleNoticeRecord, actionId: string) => Promise<void> | void

/** The answer to one click or dismissal. */
export interface ItemResult {
  readonly ok: boolean
  readonly message?: string
}

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
  /**
   * Read the sessions working right now, or undefined when this deployment has no
   * session service.
   *
   * Optional by design: the workbench is useful without it, and a deployment that
   * cannot answer simply shows no running work rather than failing to open.
   */
  readonly runningSessions?: () => Promise<readonly RunningSession[]>
  /** How often to refresh {@link runningSessions}. Defaults to 5s. */
  readonly runningRefreshMs?: number
}

/** Normalize a caller-supplied tone, defaulting to `info`. */
function toneOf(value: NoticeTone | undefined): NoticeTone {
  return value === 'success' || value === 'warn' || value === 'error' ? value : 'info'
}

/**
 * Whether two running-session lists are the same picture.
 *
 * Compared field by field so a poll that changed nothing does not bump the revision —
 * the page's poll would otherwise re-render the whole list every five seconds.
 * @param left - the previous list.
 * @param right - the candidate list.
 * @returns true when nothing a reader can see changed.
 */
function sameRunning(left: readonly RunningSession[], right: readonly RunningSession[]): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => {
    const other = right[index]
    return other !== undefined && row.sessionId === other.sessionId && row.title === other.title && row.cwd === other.cwd
  })
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
  /**
   * Who handles a click, by the kind of item clicked.
   *
   * Kept here rather than on each record: a handler is owned by the plugin that
   * registered it and dies with that plugin's fiber, while the record outlives it in
   * the queue. An item whose kind has no handler is still shown — it just cannot be
   * acted on any more, which is the honest thing to render after a plugin unloads.
   */
  private readonly actionHandlers = new Map<string, NoticeActionHandler>()
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
   * The sessions last seen working.
   *
   * Cached rather than fetched per read because `state()` is synchronous and the whole
   * page polls it: an async read per poll would make the route's latency depend on the
   * session service, and a slow one would stall the notice list with it.
   */
  private running: readonly RunningSession[] = []
  private runningTimer: NodeJS.Timeout | undefined
  /** 自动化日志，最新在前，长度封顶 {@link LOG_LIMIT}。 */
  private readonly logEntries: ConsoleLogEntry[] = []

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
    this.watchRunning()
  }

  /**
   * 定期刷新「正在跑的会话」。
   *
   * 定时器 `unref` 掉：一个只为了刷首页数字的循环不该把宿主进程按住在那里。
   */
  private watchRunning(): void {
    const read = this.options.runningSessions
    if (read === undefined) return
    const tick = async (): Promise<void> => {
      try {
        const next = await read()
        if (sameRunning(this.running, next)) return
        this.running = next
        this.bump()
      } catch (error: unknown) {
        // 会话服务读不到不是工作台的故障：首页少一块，其他照常。
        this.ctx.logger.warn(`console: reading running sessions failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void tick()
    this.runningTimer = setInterval(() => { void tick() }, this.options.runningRefreshMs ?? 5_000)
    this.runningTimer.unref?.()
  }

  /** The channels this package implements, before configuration. */
  get channels(): ChannelRegistry {
    return this.registry
  }

  /**
   * Register the handler for one kind of item.
   *
   * A kind is a namespace the raiser owns (`mailflow`, `tasks`, …). Registering twice
   * replaces: a plugin that reloads must not end up with two handlers racing.
   * @param kind - the kind this handler answers.
   * @param handler - what to do when the user picks an action.
   * @returns the disposer that removes it.
   */
  onAction(kind: string, handler: NoticeActionHandler): () => void {
    this.actionHandlers.set(kind, handler)
    return () => {
      if (this.actionHandlers.get(kind) === handler) this.actionHandlers.delete(kind)
    }
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
    return await this.raise(notice)
  }

  /**
   * Hand an **item** to the workbench: a notice that may carry actions.
   *
   * This is `notify` plus the two things a work desk needs — an identity to act on
   * later, and a state to track. A bare notice is the same call with no `actions`,
   * which is why the two share one store and one event.
   * @param notice - what to tell the user, and what they can do about it.
   * @returns the stored record.
   */
  async raise(notice: ConsoleNotice): Promise<ConsoleNoticeRecord> {
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
    const actions = Array.isArray(notice.actions) && notice.actions.length > 0
      ? notice.actions.filter(action => typeof action.id === 'string' && action.id !== '' && typeof action.label === 'string')
      : undefined
    const record: ConsoleNoticeRecord = {
      ...envelope,
      delivered,
      state: 'new',
      ...(notice.kind === undefined ? {} : { kind: notice.kind }),
      ...(actions === undefined ? {} : { actions }),
      ...(notice.sessionId === undefined ? {} : { sessionId: notice.sessionId }),
    }
    this.notices.unshift(record)
    if (this.notices.length > NOTICE_LIMIT) this.notices.length = NOTICE_LIMIT
    this.bump({ type: 'notice', notice: record, delivered })
    return record
  }

  /**
   * The user picked one of an item's actions.
   *
   * The workbench does no work itself: it finds the raiser by `kind` and hands the
   * click back. The item is marked `resolved` **only if the handler succeeded** — a
   * failed action must stay in the queue, otherwise the user is told a thing was
   * handled when it was not.
   * @param id - the item.
   * @param actionId - which of its actions.
   * @returns ok, or why not.
   */
  async actOn(id: string, actionId: string): Promise<ItemResult> {
    const item = this.notices.find(record => record.id === id)
    if (item === undefined) return { ok: false, message: '这个条目已经不在了' }
    const action = item.actions?.find(candidate => candidate.id === actionId)
    if (action === undefined) return { ok: false, message: '这个条目没有这个动作' }
    const kind = item.kind
    if (kind === undefined) return { ok: false, message: '这个条目没有归属的插件' }
    const handler = this.actionHandlers.get(kind)
    if (handler === undefined) {
      return { ok: false, message: `「${kind}」插件当前没有加载，无法执行` }
    }
    try {
      await handler(item, actionId)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`console: action "${actionId}" of ${kind} failed: ${message}`)
      return { ok: false, message }
    }
    this.replace(id, { state: 'resolved', resolvedAction: actionId })
    return { ok: true }
  }

  /**
   * The user said "not my problem".
   * @param id - the item.
   * @returns ok, or why not.
   */
  dismiss(id: string): ItemResult {
    if (!this.replace(id, { state: 'dismissed' })) return { ok: false, message: '这个条目已经不在了' }
    return { ok: true }
  }

  /**
   * Keep it out of the queue until later.
   * @param id - the item.
   * @param until - epoch ms.
   * @returns ok, or why not.
   */
  snooze(id: string, until: number): ItemResult {
    if (!Number.isFinite(until) || until <= Date.now()) return { ok: false, message: 'snooze 需要一个将来的时间' }
    if (!this.replace(id, { state: 'seen', snoozedUntil: until })) return { ok: false, message: '这个条目已经不在了' }
    return { ok: true }
  }

  /**
   * Replace one stored record and tell every open workbench.
   * @param id - the item.
   * @param change - the fields to overwrite.
   * @returns whether the item existed.
   */
  private replace(id: string, change: Partial<ConsoleNoticeRecord>): boolean {
    const index = this.notices.findIndex(record => record.id === id)
    const current = this.notices[index]
    if (current === undefined) return false
    this.notices[index] = { ...current, ...change }
    this.bump()
    return true
  }

  /**
   * Record one thing an automation did on its own.
   *
   * Not an item: it wants no decision, so it never enters the attention queue and never
   * counts towards `awaiting`. A plugin that handles a hundred messages a day calls this
   * a hundred times and nobody is nagged — which is the point of keeping the two apart.
   * @param entry - who did what, and whether it worked.
   */
  log(entry: {
    readonly source: string
    readonly title: string
    readonly detail?: string
    readonly ok?: boolean
  }): void {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
    if (title === '') return
    this.logEntries.unshift({
      id: randomUUID(),
      at: Date.now(),
      source: entry.source,
      title,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ok: entry.ok !== false,
    })
    if (this.logEntries.length > LOG_LIMIT) this.logEntries.length = LOG_LIMIT
    this.bump()
  }

  /** @returns the automation log, newest first. */
  automationLog(): readonly ConsoleLogEntry[] {
    return this.logEntries
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
      awaiting: this.awaiting(),
      availableChannels: this.channelInfos(),
      layout: this.layout,
      currentView: this.prefs.currentView ?? DEFAULT_VIEW,
      pinned: this.prefs.pinned,
      running: this.running,
      log: this.logEntries,
      revision: this.revision,
    }
  }

  /**
   * How many items still want the user.
   *
   * Counted on the Host so every screen shows the same figure, and so a queue that is
   * snoozed until later is not silently counted as pending.
   * @returns the count of items in state `new` that are not snoozed.
   */
  private awaiting(): number {
    const now = Date.now()
    const live = this.notices.filter(record =>
      record.state === 'new' && (record.snoozedUntil === undefined || record.snoozedUntil <= now))
    // 按会话去重：同一条会话既举了通知又在等回答时，它是**一件事**，不该在状态条上算两次。
    // 没有会话的条目（纯提醒）各自算一件。
    const sessions = new Set(live.flatMap(record => record.sessionId === undefined ? [] : [record.sessionId]))
    const loose = live.filter(record => record.sessionId === undefined).length
    return sessions.size + loose
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
   * Remember the view the user is on, so a reload reopens it.
   * @param view - the view to restore next time.
   */
  async setView(view: ConsoleView): Promise<void> {
    await this.ready
    if ((this.prefs.currentView ?? DEFAULT_VIEW) === view) return
    await this.save({ ...this.prefs, currentView: view })
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
