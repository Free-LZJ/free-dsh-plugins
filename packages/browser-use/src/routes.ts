/**
 * The HTTP surface the browser's `@` menu reads.
 *
 * One read-only route. `dsh-host-webserver` adds no middleware, body parsing or
 * origin policy of its own, so the same-origin guard is stated here by hand, and
 * the method is pinned: a menu lookup has no business writing anything.
 *
 * @module @free-lzj/dsh-browser-use/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge this route registers on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { MentionRegistry } from './mention.ts'
import { MENTIONS_PATH, type FailureResult, type MentionsResult } from './protocol.ts'

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot enumerate the user's tabs through their browser.
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
 * Mount the mention route.
 * @param ctx - the Host plugin context.
 * @param registry - providers to collect from.
 */
export function registerRoutes(ctx: Context, registry: MentionRegistry): void {
  ctx.inject(['webServer'], (inner) => {
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: MENTIONS_PATH,
      handler: (req, res) => handleMentions(ctx, registry, req, res),
    }), 'browser-use.mentions-route')
  })
}

/**
 * Answer one candidate request.
 * @param ctx - the Host plugin context, for logging.
 * @param registry - providers to collect from.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function handleMentions(
  ctx: Context,
  registry: MentionRegistry,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isSameOrigin(req)) {
    respond(res, 403, { error: 'cross-origin request refused' } satisfies FailureResult)
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    respond(res, 405, { error: 'method not allowed' } satisfies FailureResult)
    return
  }
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
  // The menu keeps typing while this is in flight; a superseded lookup should
  // stop its own browser work rather than finish into a discarded answer.
  const abort = new AbortController()
  res.on('close', () => { abort.abort() })
  try {
    const collected = await registry.collect(query, abort.signal)
    for (const failure of collected.failures) ctx.logger.warn(`browser-use: provider failed: ${failure}`)
    if (abort.signal.aborted) return
    respond(res, 200, {
      groups: collected.groups,
      // An empty menu is indistinguishable from a broken `bsk` without this,
      // and the menu is the only surface where the person would notice.
      ...collected.failures.length === 0 ? {} : { failures: collected.failures },
    } satisfies MentionsResult)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`browser-use: mention lookup failed: ${message}`)
    respond(res, 400, { error: message } satisfies FailureResult)
  }
}
