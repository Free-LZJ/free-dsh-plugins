/**
 * 读宿主自己的 agent 服务：哪些会话在跑、它叫什么。
 *
 * The names here are **verified against the running host**, not guessed: the host
 * composes `agents` (create / resume / list) and `sessions` (the store), and
 * `ctx.on('session/event', (session, event) => ...)` delivers a session's own
 * events. `sessionController` and `workspaceRegistry` do **not** exist — they are
 * Remote-layer names for the browser half, and referring to them here was the bug
 * that kept this bridge from ever connecting (`docs/workbench-session-api.md`).
 *
 * Everything is written structurally: this package must not import host types,
 * because these services are an *optional* dependency — a deployment composing
 * none of them simply gets no real executor.
 *
 * @module @free-lzj/dsh-console/workbench/harness-session
 */

/** One live agent, as far as this bridge cares. */
export interface HarnessAgentLike {
  /** The session this agent drives. */
  readonly session?: { readonly id?: string; readonly header?: { readonly cwd?: string } }
  /** Queue one user message; the agent loop turns it into a turn. */
  followup(message: {
    readonly role: 'user'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly source: Readonly<Record<string, unknown>>
  }): unknown
  /** Stop the current turn. */
  cancel?(): unknown
  /** Whether the agent is driving a turn right now. */
  isActive?(): boolean
}

/** The agents service: the one entry point that builds an agent *and* its session. */
export interface HarnessAgentsLike {
  /** Added by the SessionController plugin **after** this bridge is constructed. */
  createSession?(request: {
    readonly cwd: string
    readonly agentPreset?: string
  }): Promise<{ readonly agent: HarnessAgentLike }>
  list?(): readonly HarnessAgentLike[]
}

/** One session event, as `session/event` delivers it. */
export interface HarnessSessionEventLike {
  readonly type?: string
  readonly data?: { readonly reason?: { readonly kind?: string } }
}

/** One session that is driving a turn right now. */
export interface RunningAgent {
  readonly sessionId: string
  readonly cwd?: string
}

/**
 * A persisted session, as far as reading its title goes.
 *
 * Structural on purpose: the title asks two host services that this package does
 * not import (`sessions` for the record, `sessionTitle` for the projection), and
 * a deployment may compose neither.
 */
export interface SessionRecordLike {
  readonly id?: string
  snapshotEvents?(): readonly { readonly type?: string; readonly data?: unknown }[]
}

/** The title service, as far as reading a session's current title goes. */
export interface SessionTitleReaderLike {
  get(session: unknown): { readonly title?: string } | undefined
}

/** The longest first-message summary kept when no title has been generated yet. */
const SUMMARY_MAX = 60

/**
 * The title to show for a running session.
 *
 * Two real sources, in order: the session's own title projection (what the GUI
 * titles the row with), then the first human message as a summary. An empty
 * answer is a legitimate outcome — the page turns it into "unnamed session ·
 * short id" rather than printing a UUID.
 * @param session - the persisted session, when the store could find it.
 * @param titles - the title service, when the deployment composes it.
 * @returns the title or summary; `''` when neither exists.
 */
export function titleOfSession(
  session: SessionRecordLike | undefined,
  titles: SessionTitleReaderLike | undefined,
): string {
  if (session === undefined) return ''
  // 标题投影读不到（会话还没迁移、投影未就绪）不是首页的故障：退到消息摘要。
  let projected = ''
  try {
    projected = titles?.get(session)?.title?.trim() ?? ''
  } catch {
    projected = ''
  }
  if (projected !== '') return projected
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type !== 'user/message') continue
    const text = userText(event.data)
    if (text !== '') return summarize(text)
  }
  return ''
}

/**
 * Read the text of one `user/message` payload.
 * @param data - the event's data, untyped at this boundary.
 * @returns the concatenated text blocks, or `''`.
 */
function userText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const source = (data as { readonly source?: { readonly kind?: string } }).source
  if (source?.kind !== 'user') return ''
  const content = (data as { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

/**
 * Keep one printable line, short enough for a list row.
 * @param text - the message text.
 * @returns the summary.
 */
function summarize(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line
}

/**
 * Which sessions are driving a turn right now.
 *
 * Read off the live agents rather than the persisted sessions: "running" means an
 * agent is active *now*, which is exactly what the focus page asks.
 * @param agents - the agents service, when composed.
 * @returns one entry per active agent.
 */
export function runningSessionsOf(agents: HarnessAgentsLike | undefined): readonly RunningAgent[] {
  if (agents?.list === undefined) return []
  const running: RunningAgent[] = []
  for (const agent of agents.list()) {
    if (agent.isActive?.() !== true) continue
    const sessionId = agent.session?.id
    if (sessionId === undefined) continue
    const cwd = agent.session?.header?.cwd
    running.push(cwd === undefined ? { sessionId } : { sessionId, cwd })
  }
  return running
}

