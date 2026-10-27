/**
 * Turning the harness's own session services into a {@link SessionRunner}.
 *
 * The board must not know about `sessionController`, workspace attachment, or
 * session events — it asks for "start a real run", which is the one thing this
 * module does. Everything here is best-effort by design: a deployment whose
 * harness is older (no workspace registry, no rename) still gets a working run,
 * it just gets fewer niceties, and a deployment without a session controller
 * gets **no** real executor at all rather than a broken one.
 *
 * @module @free-dsh-plugins/dsh-console/workbench/harness-session
 */

import type { SessionRunner, RealRun } from './real-session.ts'

/** The session controller verbs this module uses; all verified against the harness. */
export interface SessionControllerLike {
  create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ readonly agent: LiveAgentLike } | { readonly error: unknown }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  archive?(sessionId: string): Promise<unknown>
}

/** The agent handle a session resolves to. */
export interface LiveAgentLike {
  followup(message: {
    readonly role: 'user'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly source: Readonly<Record<string, unknown>>
  }): unknown
}

/** The workspace registry: a session must be attached before it can read files. */
export interface WorkspaceRegistryLike {
  create(cwd: string): Promise<{ attachSession(sessionId: string): Promise<void> }>
}

/** What one harness session event looks like; only `type` and the session id are used. */
export interface SessionEventLike {
  readonly type?: string
}

/** Everything the runner needs, injected so it can be driven without a harness. */
export interface HarnessSessionOptions {
  readonly controller: SessionControllerLike
  readonly workspaces?: WorkspaceRegistryLike
  /** Directory real runs happen in; without it there is no place to run. */
  readonly cwd: string
  /** Subscribe to session events; returns the unsubscribe. */
  readonly subscribe: (listener: (session: { readonly id?: string }, event: SessionEventLike) => void) => () => void
  readonly log: (line: string) => void
}

/**
 * Build the runner, or undefined when the harness cannot host a real run.
 * @param options - the services and the directory.
 * @returns the runner, or undefined when a real run is impossible here.
 */
export function createHarnessRunner(options: HarnessSessionOptions): SessionRunner | undefined {
  const { controller, workspaces, cwd } = options
  if (cwd === '') return undefined
  return {
    async start(request): Promise<RealRun> {
      const created = await controller.create({ cwd })
      const sessionId = created.sessionId
      // The workspace must be attached before the first message, and the title is
      // cosmetic — both are skipped rather than failing the run when absent.
      if (workspaces !== undefined) {
        try {
          const workspace = await workspaces.create(cwd)
          await workspace.attachSession(sessionId)
        } catch (error: unknown) {
          options.log(`workbench: attaching ${sessionId} to ${cwd} failed: ${describe(error)}`)
        }
      }
      if (controller.rename !== undefined) {
        await Promise.resolve(controller.rename({ sessionId, title: request.title })).catch((error: unknown) => {
          options.log(`workbench: renaming ${sessionId} failed: ${describe(error)}`)
        })
      }
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) {
        await Promise.resolve(controller.archive?.(sessionId)).catch(() => undefined)
        throw new Error(`session ${sessionId} could not be resolved: ${describe(resolved.error)}`)
      }
      /** Settles the run's outcome; assigned by the promise below, used by `stop`. */
      let settle: ((status: 'done' | 'failed') => void) | undefined
      const finished = new Promise<'done' | 'failed'>((resolve) => {
        const unsubscribe = options.subscribe((session, event) => {
          if (session.id !== sessionId) return
          if (event.type !== 'turn/end') return
          unsubscribe()
          resolve('done')
        })
        // A run that is archived or stopped without a turn still has to settle, or
        // the card would sit in `processing` forever.
        settle = (status) => {
          unsubscribe()
          resolve(status)
        }
      })
      resolved.agent.followup({
        role: 'user',
        content: [{ type: 'text', text: request.prompt }],
        source: { plugin: 'dsh-console', card: { title: request.title } },
      })
      return {
        sessionId,
        finished,
        stop: () => {
          settle?.('failed')
          void Promise.resolve(controller.archive?.(sessionId)).catch((error: unknown) => {
            options.log(`workbench: archiving ${sessionId} failed: ${describe(error)}`)
          })
        },
      }
    },
    async send(sessionId, text): Promise<void> {
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(describe(resolved.error))
      resolved.agent.followup({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { plugin: 'dsh-console', followup: true },
      })
    },
  }
}

/** One error as a sentence. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
