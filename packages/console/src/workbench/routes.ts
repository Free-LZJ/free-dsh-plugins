/**
 * The board's HTTP surface, beside the workbench's own routes.
 *
 * Same guards as `../routes.ts` — a read must come from the page this server
 * sent, a write must additionally carry the page-only header — because
 * `dsh-host-webserver` adds no middleware of its own. The business side
 * arrives as an injected board, which keeps this module about HTTP alone and
 * testable without a filesystem or a real browser.
 *
 * One deliberate limit: the ingest route is the webhook entrance in v0, but it
 * keeps the same-origin guard, so only this server's own page (the event
 * simulator, a future local connector) can post to it. A real external
 * webhook needs signature verification first; that is later work, not a guard
 * to quietly drop.
 *
 * @module @free-lzj/dsh-console/workbench/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkbenchColumn } from '../protocol.ts'
import { isMutationRequest, isSameOrigin, readJsonBody, respond } from '../routes.ts'
import { WORKBENCH_ACTION_PATH, WORKBENCH_INGEST_PATH, WORKBENCH_STATE_PATH } from '../paths.ts'
import type { ActionResult, WorkbenchBoard } from './board.ts'
import { isWorkbenchSource } from './connectors.ts'

/** Everything the routes need from the plugin, injected so this module stays about HTTP. */
export interface WorkbenchRouteHost {
  /** The board the routes read and write. */
  readonly board: WorkbenchBoard
}

/**
 * Mount the three routes the board needs.
 * @param ctx - the Host plugin context.
 * @param host - the plugin's own read and write operations.
 */
export function registerWorkbenchRoutes(ctx: Context, host: WorkbenchRouteHost): void {
  ctx.inject(['webServer'], (inner) => {
    const register = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      label: string,
    ): void => {
      inner.effect(() => inner.webServer.register({ kind: 'exact', path, handler }), label)
    }

    /**
     * Wrap a handler so a throw answers instead of escaping into the server.
     * @param handler - the route body.
     * @param what - the operation named in logs and in the error answer.
     * @returns the guarded handler.
     */
    const guard = (
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      what: string,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      return async (req, res) => {
        if (!isSameOrigin(req)) {
          respond(res, 403, { error: 'cross-origin request refused' })
          return
        }
        try {
          await handler(req, res)
        } catch (error: unknown) {
          // Never echo request data back; the page gets a stable sentence instead.
          ctx.logger.warn(`workbench: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    /** A POST-only route that also needs the page-only header. */
    const guardMutation = (
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
      what: string,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      return guard(async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respond(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isMutationRequest(req)) {
          respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
          return
        }
        await handler(req, res)
      }, what)
    }

    /**
     * Read the board.
     *
     * `?since=<revision>` makes the poll cheap: an unchanged board answers
     * `{ unchanged: true }` (a few dozen bytes) instead of the whole document —
     * sessions and their logs included. The page polls every two seconds, so this
     * is the difference between a trickle and a stream of full snapshots.
     */
    register(WORKBENCH_STATE_PATH, guard((req, res) => {
      if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      const state = host.board.state()
      const since = queryOf(req).get('since')
      if (since !== null && since === String(state.revision)) {
        respond(res, 200, { unchanged: true, revision: state.revision })
        return
      }
      respond(res, 200, state)
    }, 'reading board state'), 'workbench.state-route')

    register(WORKBENCH_INGEST_PATH, guardMutation(async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const value = (body.value ?? {}) as Record<string, unknown>
      if (typeof value.source !== 'string' || !isWorkbenchSource(value.source)) {
        respond(res, 400, { error: 'source must be mail, webhook, dingtalk, jira, or manual' })
        return
      }
      if (typeof value.title !== 'string' || value.title.trim() === '') {
        respond(res, 400, { error: 'title must be a non-empty string' })
        return
      }
      if (value.externalId !== undefined && typeof value.externalId !== 'string') {
        respond(res, 400, { error: 'externalId must be a string' })
        return
      }
      if (value.body !== undefined && typeof value.body !== 'string') {
        respond(res, 400, { error: 'body must be a string' })
        return
      }
      const result = await host.board.ingest({
        source: value.source,
        ...(value.externalId === undefined ? {} : { externalId: value.externalId as string }),
        title: value.title as string,
        ...(value.body === undefined ? {} : { body: value.body as string }),
      })
      if (!result.ok) {
        respond(res, 400, { error: result.error })
        return
      }
      respond(res, 200, result)
    }, 'ingesting event'), 'workbench.ingest-route')

    register(WORKBENCH_ACTION_PATH, guardMutation(async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const result = runAction(host.board, body.value)
      if (!result.ok) {
        respond(res, 400, { error: result.error })
        return
      }
      respond(res, 200, result)
    }, 'running board action'), 'workbench.action-route')
  })
}

/**
 * Run one board action from a parsed body.
 * @param board - the board.
 * @param value - the parsed body.
 * @returns the action's result, or why it was refused.
 */
function runAction(board: WorkbenchBoard, value: unknown): ActionResult {
  const body = (value ?? {}) as Record<string, unknown>
  const action = body.action
  if (typeof body.cardId !== 'string' && typeof body.sessionId !== 'string') {
    return { ok: false, error: 'an action needs a cardId or a sessionId' }
  }
  switch (action) {
    case 'dispatch': {
      if (typeof body.cardId !== 'string') return { ok: false, error: 'dispatch needs a cardId' }
      return board.dispatch(
        body.cardId,
        typeof body.executor === 'string' ? body.executor : undefined,
      )
    }
    case 'move': {
      if (typeof body.cardId !== 'string') return { ok: false, error: 'move needs a cardId' }
      const column = body.column
      if (column !== 'todo' && column !== 'processing' && column !== 'done') {
        return { ok: false, error: 'column must be todo, processing, or done' }
      }
      return board.move(body.cardId, column as WorkbenchColumn)
    }
    case 'interrupt': {
      if (typeof body.sessionId !== 'string') return { ok: false, error: 'interrupt needs a sessionId' }
      if (typeof body.text !== 'string') return { ok: false, error: 'interrupt needs text' }
      return board.interrupt(body.sessionId, body.text)
    }
    case 'pause': {
      if (typeof body.sessionId !== 'string') return { ok: false, error: 'pause needs a sessionId' }
      return board.pauseSession(body.sessionId)
    }
    case 'resume': {
      if (typeof body.sessionId !== 'string') return { ok: false, error: 'resume needs a sessionId' }
      return board.resumeSession(body.sessionId)
    }
    case 'end': {
      if (typeof body.sessionId !== 'string') return { ok: false, error: 'end needs a sessionId' }
      return board.endSession(body.sessionId)
    }
    default:
      return { ok: false, error: `unknown action "${String(action)}"` }
  }
}

/** Parse a request's query string without trusting the request line. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}