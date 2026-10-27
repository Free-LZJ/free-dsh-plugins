/**
 * The session action, in the kernel: the **order**, not the wording.
 *
 * The sequence is the whole value of this action and the thing that is easy to get
 * wrong, so it lives here once:
 *
 * 1. create the session (it makes the directory and writes the header),
 * 2. attach it to the workspace (the host compares the header's cwd),
 * 3. rename it,
 * 4. set the permission **before the first message** — a follow-up already runs under
 *    whatever permission was in place when it arrived.
 *
 * What the kernel does **not** own: the prompt, the title template, the workspace
 * resolution. Those are connector-shaped (a mail names a repo out of its List-Id), and
 * a kernel that knew them would be a mail plugin with extra steps.
 *
 * And one rule that is a judgement, not a technique: **a session is never rolled back.**
 * Once it exists it may already have done work, so a failed hand-off is reported with
 * the id that lets a human look, instead of deleting the evidence.
 *
 * @module @free-lzj/dsh-decision/actions/session
 */

/** The session verbs this action drives; the connector supplies the implementation. */
export interface SessionPort {
  createSession(request: {
    readonly cwd: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: string }>
  attachSession(cwd: string, sessionId: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  setPermission(sessionId: string, preset: string): void
  followup(sessionId: string, text: string, source: Readonly<Record<string, unknown>>): Promise<void>
}

/** Everything one session needs, already rendered by the connector. */
export interface SessionRequest {
  /** Absolute directory the session runs in. */
  readonly workspace: string
  /** Title to give the session (already truncated by the caller if it cares). */
  readonly title: string
  /** The body of the first message. */
  readonly prompt: string
  readonly permissionPreset?: string
  readonly agentPreset?: string
  /** Provenance recorded on the message. */
  readonly source: Readonly<Record<string, unknown>>
}

/** What a session run answers with. */
export type SessionOutcome =
  | { readonly ok: true; readonly detail: string; readonly sessionId: string }
  | { readonly ok: false; readonly message: string; readonly sessionId?: string }

/** What one session run needs from the host. */
export interface SessionContext {
  readonly sessions?: SessionPort
  readonly log: (line: string) => void
}

/**
 * Run the session action.
 * @param request - the rendered session request.
 * @param context - the session port and a log line sink.
 * @returns what happened, with the session id whenever one exists.
 */
export async function runSession(request: SessionRequest, context: SessionContext): Promise<SessionOutcome> {
  const sessions = context.sessions
  if (sessions === undefined) {
    return { ok: false, message: '未挂载会话服务，无法新建会话' }
  }
  let sessionId: string
  try {
    const created = await sessions.createSession({
      cwd: request.workspace,
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })
    sessionId = created.sessionId
  } catch (error: unknown) {
    return { ok: false, message: `新建会话失败：${describe(error)}` }
  }
  try {
    await sessions.attachSession(request.workspace, sessionId)
    await sessions.rename(sessionId, request.title)
    if (request.permissionPreset !== undefined) sessions.setPermission(sessionId, request.permissionPreset)
    await sessions.followup(sessionId, request.prompt, request.source)
  } catch (error: unknown) {
    // 会话已经建出来了，回滚它比留着更糟——它可能已经收到消息。说清失败，并把 id 带回去。
    const message = describe(error)
    context.log(`会话 ${sessionId} 交接失败：${message}`)
    return { ok: false, message: `会话已建但交接失败（${message}）`, sessionId }
  }
  return { ok: true, detail: `已在「${request.workspace}」新建会话`, sessionId }
}

/** One error as a sentence. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
