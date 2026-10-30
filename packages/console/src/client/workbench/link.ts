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
import { WORKBENCH_ACTION_PATH, WORKBENCH_STATE_PATH } from '../../paths.ts'
import type { WorkbenchLogDelta, WorkbenchState } from '../../protocol.ts'

/** How often the page re-reads the board while it is open. */
const POLL_MS = 2000

/**
 * The newest log timestamp in one snapshot.
 * @param sessions - the snapshot's sessions.
 * @returns epoch ms, or 0 before any line.
 */
function newestLogAt(sessions: WorkbenchState['sessions']): number {
  let newest = 0
  for (const session of sessions) {
    for (const line of session.logs) newest = Math.max(newest, line.at)
  }
  return newest
}

/** What the page can do with the board. */
export class WorkbenchLink {
  private snapshot: WorkbenchState | undefined
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** 最近一条已收到的日志时间；轮询带它只取新增行。 */
  private logCursor = 0

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

  /**
   * Read the snapshot once.
   *
   * Asks for a revision-stamped answer: an unchanged board costs a few dozen
   * bytes and does not repaint. A hidden tab does not poll at all — the timer is
   * for a page someone is looking at, and coming back triggers one read.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    if (typeof document !== 'undefined' && document.hidden === true) return
    const since = this.snapshot?.revision
    const query = since === undefined
      ? ''
      : `?since=${String(since)}&logsSince=${String(this.logCursor)}`
    try {
      const response = await fetch(`${WORKBENCH_STATE_PATH}${query}`, { cache: 'no-store' })
      if (!response.ok) return
      const answer = await response.json() as
        | WorkbenchState
        | { unchanged: true; revision: number }
        | WorkbenchLogDelta
      if ('logs' in answer) {
        this.mergeLogs(answer)
        return
      }
      if ('unchanged' in answer) {
        // Nothing moved: keep the snapshot object, so no reader re-renders.
        return
      }
      this.snapshot = answer
      this.logCursor = newestLogAt(answer.sessions)
      this.publish()
    } catch {
      // Offline or restarting: the next poll covers it.
    }
  }

  /**
   * Fold log-only updates into the snapshot without replacing it wholesale.
   *
   * The structure did not change, so only the sessions named in the delta are
   * recreated; every other object keeps its identity and its readers do not
   * repaint.
   * @param delta - the new lines the Host sent.
   */
  private mergeLogs(delta: WorkbenchLogDelta): void {
    const snapshot = this.snapshot
    if (snapshot === undefined) return
    const byId = new Map(snapshot.sessions.map(session => [session.id, session]))
    for (const entry of delta.logs) {
      const session = byId.get(entry.sessionId)
      if (session === undefined || entry.lines.length === 0) continue
      const updatedAt = Math.max(session.updatedAt, ...entry.lines.map(line => line.at))
      byId.set(entry.sessionId, {
        ...session,
        logs: [...session.logs, ...entry.lines].slice(-200),
        updatedAt,
      })
      this.logCursor = Math.max(this.logCursor, updatedAt)
    }
    this.snapshot = { ...snapshot, sessions: [...byId.values()] }
    this.publish()
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
