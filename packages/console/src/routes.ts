/**
 * The HTTP surface an open workbench speaks to.
 *
 * These routes sit beside the harness's own rather than inside the API gateway's
 * session check, and `dsh-host-webserver` adds no middleware, body parsing or
 * origin policy of its own — so every guard is stated here: a read must come
 * from the page this server sent, and a write must additionally carry a header
 * a cross-site form cannot set.
 *
 * The business side arrives as an injected {@link RouteHost}, which keeps this
 * module about HTTP alone — statuses, headers, bounded bodies, the event stream —
 * and testable without a filesystem or a real browser.
 *
 * @module @free-lzj/dsh-console/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConsoleHost, ItemResult } from './console-host.ts'
import type { ConsoleLayout, ConsoleState } from './protocol.ts'
import { CONFIG_PATH, EVENTS_PATH, ITEM_PATH, STATE_PATH } from './paths.ts'

/** Header a mutating request must carry, together with a JSON content type. */
export const MUTATION_HEADER = 'x-dsh-console'

/** Largest request body a route reads; every payload here is a small object. */
export const MAX_BODY_BYTES = 16 * 1024

/** How often an idle event stream sends a comment so a proxy keeps it open. */
export const HEARTBEAT_MS = 25_000

/** Everything the routes need from the plugin, injected so this module stays about HTTP. */
export interface RouteHost {
  /** The service the routes read and write. */
  readonly console: ConsoleHost
  /** The state to answer with — the Host's notices, channels and preferences. */
  state(): ConsoleState
  /** Enable/disable channels in the Loader row config. */
  setChannels(channels: readonly string[]): Promise<void>
  /** Persist the view layout. */
  setLayout(layout: ConsoleLayout): Promise<void>
}

/** What reading a request body produced. */
export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot read these routes through the user's browser.
 * @param req - the incoming request.
 * @returns true when the request comes from this server's own page.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    // An unparseable Origin is not this server's own page.
    return false
  }
}

/**
 * Whether a mutating request carries the marks only this page makes.
 * @param req - the incoming request.
 * @returns true when the request may change saved preferences.
 */
export function isMutationRequest(req: IncomingMessage): boolean {
  if (req.headers[MUTATION_HEADER] !== '1') return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

/**
 * Mount the three routes the workbench needs.
 *
 * Only the two `kind` literals `dsh-host-webserver` knows are ever passed: its
 * implementation picks the route table with `kind === 'exact'` and validates
 * nothing, so a typo would silently become a prefix route.
 * @param ctx - the Host plugin context.
 * @param host - the plugin's own read and write operations.
 */
export function registerRoutes(ctx: Context, host: RouteHost): void {
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
          ctx.logger.warn(`console: ${what} failed: ${describe(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    register(STATE_PATH, guard((_req, res) => {
      respond(res, 200, host.state())
    }, 'reading state'), 'console.state-route')

    register(EVENTS_PATH, guard((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // The browser must not reuse a proxy's buffered copy of a stream.
        'x-accel-buffering': 'no',
      })
      res.write(': console stream\n\n')
      const send = (event: string, data: unknown): void => {
        if (res.writableEnded) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('state', host.state())
      const closeGate = host.console.presence.open()
      const unsubscribe = host.console.subscribe((event) => {
        if (event.type === 'notice') send('notice', { notice: event.notice, delivered: event.delivered })
        else send('state', host.state())
      })
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
      const finish = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
        closeGate()
      }
      req.on('close', finish)
      res.on('close', finish)
    }, 'streaming events'), 'console.events-route')

    register(CONFIG_PATH, guard(async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isMutationRequest(req)) {
        respond(res, 403, { error: `a mutating request needs ${MUTATION_HEADER}: 1 and a JSON content type` })
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const command = readConfigCommand(body.value)
      if (!command.ok) {
        respond(res, 400, { error: command.error })
        return
      }
      try {
        await command.apply(host)
      } catch (error: unknown) {
        respond(res, 400, { error: describe(error) })
        return
      }
      respond(res, 200, { ok: true })
    }, 'saving configuration'), 'console.config-route')

    register(ITEM_PATH, guard(async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isMutationRequest(req)) {
        respond(res, 403, { error: `a mutating request needs ${MUTATION_HEADER}: 1 and a JSON content type` })
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const command = readItemCommand(body.value)
      if (!command.ok) {
        respond(res, 400, { error: command.error })
        return
      }
      const result = await command.apply(host)
      // A refusal carries the reason so the page can show it next to the item; the
      // item itself is untouched either way (a failed action must stay actionable).
      if (!result.ok) {
        respond(res, 400, { error: result.message ?? 'rejected' })
        return
      }
      respond(res, 200, { ok: true })
    }, 'acting on an item'), 'console.item-route')
  })
}

/** One accepted configuration command. */
type ConfigCommand =
  | { readonly ok: true; apply(host: RouteHost): Promise<void> }
  | { readonly ok: false; readonly error: string }

/** One accepted item command. */
type ItemCommand =
  | { readonly ok: true; apply(host: RouteHost): Promise<ItemResult> }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one item payload.
 *
 * The three verbs are the whole vocabulary of a work queue: pick an action, say "not
 * mine", or say "later". Nothing here writes anything itself — `act` is handed back
 * to the plugin that raised the item.
 * @param value - the parsed JSON body.
 * @returns the command, or why it was refused.
 */
function readItemCommand(value: unknown): ItemCommand {
  const body = (value ?? {}) as Record<string, unknown>
  const id = body.id
  if (typeof id !== 'string' || id === '') return { ok: false, error: 'id must not be empty' }
  switch (body.op) {
    case 'act': {
      const actionId = body.actionId
      if (typeof actionId !== 'string' || actionId === '') {
        return { ok: false, error: 'act needs an actionId' }
      }
      return { ok: true, apply: async (host) => await host.console.actOn(id, actionId) }
    }
    case 'dismiss':
      return { ok: true, apply: (host) => Promise.resolve(host.console.dismiss(id)) }
    case 'snooze': {
      const until = body.until
      if (typeof until !== 'number' || !Number.isFinite(until)) {
        return { ok: false, error: 'snooze needs a numeric until (epoch ms)' }
      }
      return { ok: true, apply: (host) => Promise.resolve(host.console.snooze(id, until)) }
    }
    default:
      return { ok: false, error: 'op must be act, dismiss or snooze' }
  }
}

/**
 * Validate one config payload before anything is written.
 * @param value - the parsed JSON body.
 * @returns the command, or why it was refused.
 */
function readConfigCommand(value: unknown): ConfigCommand {
  const body = (value ?? {}) as Record<string, unknown>
  if (body.layout !== undefined) {
    const layout = body.layout
    if (layout !== 'grid' && layout !== 'list' && layout !== 'compact') {
      return { ok: false, error: 'layout must be grid, list or compact' }
    }
    return { ok: true, apply: (host) => host.setLayout(layout) }
  }
  if (body.channels !== undefined) {
    const channels = body.channels
    if (!Array.isArray(channels) || channels.length === 0 || !channels.every((entry) => typeof entry === 'string')) {
      return { ok: false, error: 'channels must be a non-empty array of channel ids' }
    }
    return { ok: true, apply: (host) => host.setChannels(channels as string[]) }
  }
  if (body.pinned !== undefined) {
    const pinned = body.pinned as Record<string, unknown>
    if (typeof pinned?.id !== 'string' || typeof pinned?.pinned !== 'boolean') {
      return { ok: false, error: 'pinned must be { id: string, pinned: boolean }' }
    }
    return { ok: true, apply: (host) => host.console.setPinned(pinned.id as string, pinned.pinned as boolean) }
  }
  if (body.notices !== undefined) {
    if (body.notices !== 'clear') return { ok: false, error: 'notices accepts only "clear"' }
    return {
      ok: true,
      apply: (host) => {
        host.console.clearNotices()
        return Promise.resolve()
      },
    }
  }
  return { ok: false, error: 'unknown configuration' }
}

/**
 * Answer one request with a JSON document.
 * @param res - the response to write.
 * @param status - HTTP status.
 * @param body - the document.
 */
export function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}
/**
 * Read a bounded JSON body.
 * @param req - the incoming request.
 * @returns the parsed value, or the status and message to answer with.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'request body too large' }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, status: 400, error: 'body is not valid JSON' }
  }
}

/** Describe any thrown value for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
