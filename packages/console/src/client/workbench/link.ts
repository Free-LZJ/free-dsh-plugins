/**
 * The page's link to the board.
 *
 * Unlike the workbench's own link (`../link.ts`), this one polls: the board
 * serves state over plain routes and has no event stream of its own yet, so a
 * two-second poll is the v0 shape. A mutation refreshes immediately after the
 * write, so a click never waits for the next poll to repaint.
 *
 * @module @free-lzj/dsh-console/client/workbench/link
 */

import { MUTATION_HEADER } from '../link.ts'
import { WORKBENCH_ACTION_PATH, WORKBENCH_INGEST_PATH, WORKBENCH_STATE_PATH } from '../../paths.ts'
import type { WorkbenchState } from '../../protocol.ts'

/** How often the page re-reads the board while it is open. */
const POLL_MS = 2000

/** What the page can do with the board. */
export class WorkbenchLink {
  private snapshot: WorkbenchState | undefined
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  /** Last snapshot the Host sent, or undefined before the first answer. */
  getSnapshot(): WorkbenchState | undefined {
    return this.snapshot
  }

  /** @param fn - invalidation callback. @returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Start polling (idempotent). */
  open(): void {
    if (this.timer !== undefined) return
    void this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, POLL_MS)
    this.timer.unref?.()
  }

  /** Stop polling and drop the readers (the plugin's unload). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  /** Read the snapshot once. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const response = await fetch(WORKBENCH_STATE_PATH, { cache: 'no-store' })
      if (!response.ok) return
      this.snapshot = await response.json() as WorkbenchState
      this.publish()
    } catch {
      // Offline or restarting: the next poll covers it.
    }
  }

  /**
   * Post one inbound event.
   * @param event - the event the simulator built.
   * @returns the Host's answer, parsed.
   */
  async ingest(event: { source: string; title: string; body?: string }): Promise<Record<string, unknown>> {
    return this.post(WORKBENCH_INGEST_PATH, event)
  }

  /**
   * Run one board action, then refresh so the click repaints at once.
   * @param body - the action body.
   * @returns whether the Host accepted it.
   */
  async act(body: Record<string, unknown>): Promise<boolean> {
    const answer = await this.post(WORKBENCH_ACTION_PATH, body)
    if (answer.ok === true) void this.refresh()
    return answer.ok === true
  }

  /** Post one JSON body with the page-only header. */
  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
        body: JSON.stringify(body),
      })
      const parsed = await response.json().catch(() => ({})) as Record<string, unknown>
      return { ...parsed, ok: response.ok && parsed.ok !== false }
    } catch {
      return { ok: false, error: 'board unreachable' }
    }
  }

  /** Notify the readers. */
  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
