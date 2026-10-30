/**
 * The session store: the board's data about agent sessions, nothing else.
 *
 * A session is data — an id, the card it works, a status, a log — while the
 * run itself lives in the executor's handle. Keeping the two apart is what
 * lets the board pause, resume, and end a run without knowing which executor
 * runs it, and what lets a restored session (whose handle died with the last
 * process) be honestly `paused` instead of pretending to still run.
 *
 * @module @free-lzj/dsh-console/workbench/sessions
 */

import { randomUUID } from 'node:crypto'
import type { WorkbenchLogLine, WorkbenchSession, WorkbenchSessionStatus } from '../protocol.ts'

/** The session store: create, read, append, and move sessions. */
export class SessionStore {
  private readonly sessions = new Map<string, WorkbenchSession>()

  /**
   * Start a session record.
   * @param cardId - the card this session works.
   * @param executor - the executor id running it.
   * @returns the session.
   */
  create(cardId: string, executor: string): WorkbenchSession {
    const now = Date.now()
    const session: WorkbenchSession = {
      id: randomUUID(),
      cardId,
      executor,
      status: 'running',
      logs: [],
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** @param id - session id. @returns the session, or undefined. */
  get(id: string): WorkbenchSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Adopt a session that was created outside the board (a rule action or a tool).
   *
   * Its id is the host's session id, so the card and the conversation page point
   * at the same thing; re-adopting an existing id leaves it untouched.
   * @param id - the host session id.
   * @param cardId - the card this session works.
   * @param executor - the executor id recorded on the session.
   * @returns the session.
   */
  adopt(id: string, cardId: string, executor: string): WorkbenchSession {
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    const now = Date.now()
    const session: WorkbenchSession = {
      id,
      cardId,
      executor,
      status: 'running',
      logs: [],
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(id, session)
    return session
  }

  /** @returns every session, oldest first. */
  list(): WorkbenchSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Append one log line.
   * @param id - session id.
   * @param text - the line.
   * @param at - the line's timestamp, supplied by the board so lines stay strictly ordered.
   * @returns the updated session, or undefined.
   */
  appendLog(id: string, text: string, at: number = Date.now()): WorkbenchSession | undefined {
    const session = this.sessions.get(id)
    if (session === undefined) return undefined
    const line: WorkbenchLogLine = { at, text }
    const next: WorkbenchSession = {
      ...session,
      logs: [...session.logs, line].slice(-200),
      updatedAt: at,
    }
    this.sessions.set(id, next)
    return next
  }

  /**
   * Move a session to a new status.
   * @param id - session id.
   * @param status - the new status.
   * @returns the updated session, or undefined.
   */
  setStatus(id: string, status: WorkbenchSessionStatus): WorkbenchSession | undefined {
    const session = this.sessions.get(id)
    if (session === undefined) return undefined
    const next: WorkbenchSession = { ...session, status, updatedAt: Date.now() }
    this.sessions.set(id, next)
    return next
  }

  /**
   * Restore sessions from a persisted document.
   *
   * A session that was `running` when the process died cannot still be
   * running — its executor handle is gone — so it comes back `paused`, and
   * its card comes back `paused` with it. Anything else restores as stored.
   * @param sessions - the stored sessions.
   */
  restore(sessions: readonly WorkbenchSession[]): void {
    for (const session of sessions) {
      this.sessions.set(session.id, {
        ...session,
        status: session.status === 'running' ? 'paused' : session.status,
      })
    }
  }
}
