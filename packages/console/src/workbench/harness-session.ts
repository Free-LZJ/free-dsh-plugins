/**
 * Turning the harness's own agent services into a {@link SessionRunner}.
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

import type { RealRun, SessionRunner } from './real-session.ts'

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
  createSession(request: {
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

/** Everything the runner needs, injected so it can be driven without a harness. */
export interface HarnessSessionOptions {
  readonly agents: HarnessAgentsLike
  /** Directory real runs happen in; without it there is no place to run. */
  readonly cwd: string
  /** Subscribe to session events; the host's `session/event`. */
  readonly subscribe: (
    listener: (session: { readonly id?: string }, event: HarnessSessionEventLike) => void,
  ) => () => void
  readonly log: (line: string) => void
}

/**
 * Build the runner, or undefined when there is nowhere to run.
 * @param options - the service and the directory.
 * @returns the runner, or undefined when a real run is impossible here.
 */
export function createHarnessRunner(options: HarnessSessionOptions): SessionRunner | undefined {
  const { agents, cwd } = options
  if (cwd === '') return undefined
  // `agents` 这个服务本身只有 create/resume；**createSession 是别处加上去的**
  // （实测：`SessionController` 插件构造的内部 ApiSessionAgentController）。没被
  // 加上时早点说清楚，而不是等到派单那一步才抛一句看不懂的 TypeError。
  if (typeof agents.createSession !== 'function') {
    options.log(
      'workbench: this deployment\'s agents service has no createSession, so the real executor stays off '
      + '(it needs the sessionController plugin composed)',
    )
    return undefined
  }
  /** The agents this runner started, so a follow-up reaches the right one. */
  const started = new Map<string, HarnessAgentLike>()

  return {
    async start(request): Promise<RealRun> {
      const { agent } = await agents.createSession({ cwd })
      const sessionId = agent.session?.id
      if (sessionId === undefined) {
        // 建了代理却没有会话 id：既不能收尾也不能投话，别让它挂在「进行中」。
        agent.cancel?.()
        throw new Error('the created agent reported no session id')
      }
      started.set(sessionId, agent)
      /** Settles the run's outcome; assigned by the promise below, used by `stop`. */
      let settle: ((status: 'done' | 'failed') => void) | undefined
      const finished = new Promise<'done' | 'failed'>((resolve) => {
        // 订阅要在投话**之前**：一轮对话可能结束得很快，先投话再订阅会漏掉 turn/end。
        const unsubscribe = options.subscribe((session, event) => {
          if (session.id !== sessionId) return
          if (event.type !== 'turn/end') return
          unsubscribe()
          resolve(event.data?.reason?.kind === 'completed' ? 'done' : 'failed')
        })
        settle = (status) => {
          unsubscribe()
          resolve(status)
        }
      })
      agent.followup({
        role: 'user',
        content: [{ type: 'text', text: request.prompt }],
        source: { plugin: 'dsh-console', card: { title: request.title } },
      })
      return {
        sessionId,
        finished,
        stop: () => {
          settle?.('failed')
          started.delete(sessionId)
          try {
            agent.cancel?.()
          } catch (error: unknown) {
            options.log(`workbench: cancelling ${sessionId} failed: ${describe(error)}`)
          }
        },
      }
    },

    async send(sessionId, text): Promise<void> {
      const agent = started.get(sessionId)
      if (agent === undefined) throw new Error(`session "${sessionId}" was not started here`)
      agent.followup({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { plugin: 'dsh-console', followup: true },
      })
    },
  }
}

/** One session that is driving a turn right now. */
export interface RunningAgent {
  readonly sessionId: string
  readonly cwd?: string
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

/** One error as a sentence. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
