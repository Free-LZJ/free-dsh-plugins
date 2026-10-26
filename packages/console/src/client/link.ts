/**
 * The workbench's single link to its Host, opened once per page.
 *
 * The home list, the notice centre and the settings row all read this module's
 * snapshot. One instance is the point: a page that opened one connection per
 * reader would deliver every notice twice and reconnect twice after a restart.
 * A module-level singleton is acceptable here precisely because a second
 * workbench is not a composition this package supports — and because the link
 * is inert until `apply` opens it.
 *
 * @module @free-lzj/dsh-console/client/link
 */

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import { CONFIG_PATH, EVENTS_PATH, ITEM_PATH, STATE_PATH } from '../paths.ts'
import type { ConsoleLayout, ConsoleNoticeRecord, ConsoleState } from '../protocol.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Header a mutating request must carry; the Host refuses to write without it. */
export const MUTATION_HEADER = 'x-dsh-console'

/** The longest delay between reconnects. */
const MAX_BACKOFF_MS = 15_000

/** One notice as the event stream delivers it. */
export interface DeliveredNotice {
  readonly notice: ConsoleNoticeRecord
  readonly delivered: readonly string[]
}

/** What the page can do with the Host. */
export class ConsoleLink {
  private snapshot: ConsoleState | undefined
  private layout: ConsoleLayout = 'grid'
  private locale = 'en'
  private readonly listeners = new Set<() => void>()
  private readonly noticeListeners = new Set<(notice: DeliveredNotice) => void>()
  private stream: EventSource | undefined
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  /** Last snapshot the Host sent, or undefined before the first answer. */
  getSnapshot(): ConsoleState | undefined {
    return this.snapshot
  }

  /** The layout the user saved, as far as this page knows it. */
  layoutPreference(): ConsoleLayout {
    return this.layout
  }

  /**
   * Adopt a layout locally before the Host confirms it, so a click repaints now.
   * @param layout - the chosen layout.
   */
  setLayout(layout: ConsoleLayout): void {
    this.layout = layout
    this.publish()
    void this.configure({ layout })
  }

  /** @param fn - invalidation callback. @returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Observe delivered notices.
   * @param fn - receives every notice the stream carries.
   * @returns the unsubscribe function.
   */
  onNotice(fn: (notice: DeliveredNotice) => void): () => void {
    this.noticeListeners.add(fn)
    return () => {
      this.noticeListeners.delete(fn)
    }
  }

  /**
   * Pin or unpin one panel.
   * @param id - panel id.
   * @param pinned - wanted state.
   */
  setPinned(id: string, pinned: boolean): void {
    // Optimistic: the row moves at once, and the Host's next snapshot is the
    // authority if the write is refused. The rows themselves are assembled from
    // this list, so flipping the id here is enough to repaint.
    const current = this.snapshot
    if (current !== undefined) {
      const next = current.pinned.filter((entry) => entry !== id)
      if (pinned) next.push(id)
      this.snapshot = { ...current, pinned: next }
    }
    this.publish()
    void this.configure({ pinned: { id, pinned } })
  }

  /**
   * Replace the enabled channel set.
   * @param channels - channel ids to enable.
   * @returns whether the Host accepted the write.
   */
  saveChannels(channels: readonly string[]): Promise<boolean> {
    return this.configure({ channels: [...channels] }).then((ok) => {
      if (ok) void this.refresh()
      return ok
    })
  }

  /**
   * Drop the notice list on the Host.
   * @returns whether the Host accepted it.
   */
  clearNotices(): Promise<boolean> {
    const cleared = this.snapshot
    if (cleared !== undefined) {
      this.snapshot = { ...cleared, notices: [] }
      this.publish()
    }
    return this.configure({ notices: 'clear' })
  }

  /**
   * Read the snapshot once.
   * @returns a promise settling when the read finished (success or not).
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const response = await fetch(`${STATE_PATH}?${this.query()}`, { cache: 'no-store' })
      if (!response.ok) return
      const state = await response.json() as ConsoleState
      this.snapshot = state
      this.layout = state.layout
      this.publish()
    } catch {
      // Offline or restarting: the stream's own retry covers it.
    }
  }

  /**
   * Open the event stream (idempotent).
   * @param locale - the locale the Host should localize titles in.
   */
  open(locale: string): void {
    if (this.stream !== undefined || typeof EventSource === 'undefined') return
    this.locale = locale
    void this.refresh()
    this.connect()
  }

  /** Close the stream and every subscription (the plugin's unload). */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.stream?.close()
    this.stream = undefined
    this.listeners.clear()
    this.noticeListeners.clear()
  }

  /** Write one command the Host validates. */
  private async configure(body: unknown): Promise<boolean> {
    try {
      const response = await fetch(CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        void this.refresh()
        return false
      }
      return true
    } catch {
      void this.refresh()
      return false
    }
  }

  /**
   * Tell the Host what the user did with one item.
   *
   * The Host routes the click back to whichever plugin raised it, so the page never
   * knows what an action means — it only knows the item's id and the action's id.
   * @param body - `{op, id}` plus `actionId` for `act` or `until` for `snooze`.
   * @returns ok, or the Host's reason (shown next to the item).
   */
  async actOnItem(body: {
    readonly op: 'act' | 'dismiss' | 'snooze'
    readonly id: string
    readonly actionId?: string
    readonly until?: number
  }): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetch(ITEM_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        // The Host pushes the new state over the stream; a refresh covers the case
        // where the stream is not connected (a freshly reloaded page).
        void this.refresh()
        return { ok: true }
      }
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined
      void this.refresh()
      return {
        ok: false,
        message: typeof payload?.error === 'string' ? payload.error : `HTTP ${String(response.status)}`,
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The stream address. */
  private query(): string {
    return new URLSearchParams({ locale: this.locale }).toString()
  }

  /** Open the stream and wire its three events. */
  private connect(): void {
    if (this.disposed || typeof EventSource === 'undefined') return
    const source = new EventSource(`${EVENTS_PATH}?${this.query()}`)
    this.stream = source
    source.addEventListener('state', (event) => {
      this.retry = 0
      try {
        const state = JSON.parse((event as MessageEvent<string>).data) as ConsoleState
        this.snapshot = state
        this.layout = state.layout
        this.publish()
      } catch {
        // A truncated frame is a Host fault; keep the last good snapshot.
      }
    })
    source.addEventListener('notice', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as DeliveredNotice
        for (const listener of [...this.noticeListeners]) listener(payload)
      } catch {
        // Same as above: one bad frame must not close the stream.
      }
    })
    source.addEventListener('error', () => {
      source.close()
      this.stream = undefined
      if (this.disposed) return
      this.retry = Math.min(this.retry + 1, 6)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        this.connect()
      }, Math.min(250 * 2 ** this.retry, MAX_BACKOFF_MS))
    })
  }

  /** Notify the readers. */
  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** The page's link. */
export const link = new ConsoleLink()

/**
 * Bind the link to a typed selector hook through React's external-store shim,
 * capturing subscribe/getSnapshot once so components never resubscribe.
 * @param source - the snapshot source.
 * @returns the hook.
 */
export function bindSelector<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }): SnapshotSelectorHook<T> {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(select: (state: T) => S, equal?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, select, equal)
  }
}
