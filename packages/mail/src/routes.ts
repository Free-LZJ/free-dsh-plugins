/**
 * The HTTP surface the panel speaks to.
 *
 * These routes sit beside the harness's own routes rather than inside the API
 * gateway's session check, and `dsh-host-webserver` adds nothing of its own — no
 * middleware, no body parsing, no origin policy (verified: `register()`'s only
 * judgement is `kind === 'exact'`). So every guard is stated here: a read must
 * come from the page this server sent, and a write must additionally carry a
 * header a cross-site form cannot set.
 *
 * The business side arrives as an injected `RouteHost`, which keeps this module
 * about HTTP alone — statuses, headers, bounded bodies — and testable without an
 * IMAP server or a credentials store.
 *
 * @module @free-lzj/dsh-mail/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { MailDetail, MailState, RouteResult } from './types.ts'
import {
  ACTION_PATH, ATTACHMENT_PATH, CONFIG_PATH, MESSAGE_PATH, MORE_PATH, PANEL_PATH, REFRESH_PATH, STATE_PATH,
} from './paths.ts'

/** Header a mutating request must carry, together with a JSON content type. */
export const MUTATION_HEADER = 'x-dsh-mail'

/** Largest request body a route reads; every payload here is a small object. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Content-Security-Policy the panel document is served under.
 *
 * `img-src` has to admit remote images even though the panel itself loads none:
 * a `srcdoc` frame inherits its parent's policy and a frame can only tighten it,
 * so a narrower parent would veto the reading pane's "显示图片" button no matter
 * what the frame's own meta tag says (measured in a real Chromium). Both schemes
 * are listed because the mail that arrives uses both, and the frame's own policy
 * allows `http:` for the same reason it allows `https:` — the button is a
 * per-message decision about *remote*, not about which scheme is prettier.
 * Not loading remote images by default is the panel's job — it strips the
 * original URLs before they ever reach the frame.
 */
export const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: http: https:',
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** What reading a request body produced. */
export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** One attachment as it is streamed back to the browser. */
export interface AttachmentPayload {
  readonly filename: string
  readonly contentType: string
  readonly content: NodeJS.ReadableStream
}

/** Everything the routes need from the plugin, injected so this module stays about HTTP. */
export interface RouteHost {
  /** Current inbox snapshot. Read from memory — the panel polls this every 10s. */
  state(): MailState
  /** One message body, or undefined when it is gone. */
  detail(accountId: string, folder: string, uid: number): Promise<MailDetail | undefined>
  /** One attachment, or undefined when it is gone. */
  attachment(accountId: string, folder: string, uid: number, part: string): Promise<AttachmentPayload | undefined>
  /** The panel document, read from disk. */
  panelDocument(): string
  /** Apply one action (detailed design §4). */
  action(input: unknown): Promise<RouteResult>
  /** Read or write accounts and preferences (detailed design §2). */
  config(input: unknown): Promise<RouteResult>
  /**
   * Scan now, because somebody pressed a button.
   *
   * Distinct from the scan a `state` poll may start: that one is rate-limited so
   * a ten-second poll does not hammer the server — which also meant pressing
   * "refresh" did nothing at all.
   * @param input - `{ accountId? }`; every account when absent.
   */
  refresh(input: unknown): Promise<RouteResult>
  /**
   * Fetch one older page, because somebody asked for the history.
   *
   * The counterpart of `refresh`, which can only ever walk forwards: a scan
   * starts above the cursor, so mail older than the window is reachable only
   * through a pass that is told where to stop.
   * @param input - `{ accountId?, folder? }`; every account, and the watched
   * folder, when absent.
   */
  more(input: unknown): Promise<RouteResult>
}

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot read a route through the user's browser.
 *
 * A browser states the relationship in `Sec-Fetch-Site`; a request that carries
 * no such header is not a cross-site document request (a local client, or an
 * older browser), and one that states `same-origin` or `none` is the harness's
 * own page or a direct navigation. Any stated `Origin` must still name the host
 * the request was addressed to.
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
 * @returns true when the request may change message state or configuration.
 */
export function isMutationRequest(req: IncomingMessage): boolean {
  if (req.headers[MUTATION_HEADER] !== '1') return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

/**
 * Read one JSON request body, bounded.
 * @param req - the incoming request.
 * @returns the parsed value, or the status and message to answer with.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) {
        req.resume()
        return { ok: false, status: 413, error: 'request body too large' }
      }
      chunks.push(buffer)
    }
  } catch (error: unknown) {
    return { ok: false, status: 400, error: `unreadable request body: ${describe(error)}` }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return { ok: false, status: 400, error: 'request body must be JSON' }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, status: 400, error: 'request body must be JSON' }
  }
}

/**
 * Where a value carries a BigInt, as dotted paths.
 *
 * Only ever called after serialization has already failed, so the walk costs
 * nothing on the happy path — and a bare "cannot serialize" with no location is
 * the kind of error that costs an hour.
 * @param value - the payload that failed.
 * @param path - the path walked so far.
 * @param budget - how many paths to collect before giving up.
 * @returns up to `budget` paths.
 */
function bigintPaths(value: unknown, path = '', budget = 8): string[] {
  if (budget <= 0) return []
  if (typeof value === 'bigint') return [path === '' ? '(root)' : path]
  if (Array.isArray(value)) {
    const found: string[] = []
    for (const [index, item] of value.entries()) {
      found.push(...bigintPaths(item, `${path}[${String(index)}]`, budget - found.length))
      if (found.length >= budget) break
    }
    return found
  }
  if (value === null || typeof value !== 'object') return []
  const found: string[] = []
  for (const [key, inner] of Object.entries(value)) {
    found.push(...bigintPaths(inner, path === '' ? key : `${path}.${key}`, budget - found.length))
    if (found.length >= budget) break
  }
  return found
}

/**
 * Answer one request with a JSON body and no caching.
 * @param res - the response to own.
 * @param status - HTTP status to answer with.
 * @param payload - value to serialize.
 */
export function respond(res: ServerResponse, status: number, payload: unknown): void {
  let body: string
  try {
    body = JSON.stringify(payload)
  } catch (error: unknown) {
    // A payload that cannot be serialized must not take the whole panel down:
    // every poll would fail the same way. Answer with what went wrong, and where,
    // instead of throwing into the guard, which could only say "state failed".
    const where = bigintPaths(payload)
    status = 500
    body = JSON.stringify({
      error: `response could not be serialized: ${describe(error)}${where.length === 0 ? '' : ` at ${where.join(', ')}`}`,
      code: 'unserializable',
    })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Answer one request with a document, under the panel's own policy.
 * @param res - the response to own.
 * @param status - HTTP status to answer with.
 * @param body - the document.
 * @param contentType - media type of the body.
 * @param extraHeaders - headers this answer must also carry.
 */
export function respondDocument(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * Mount the six routes the panel needs.
 *
 * Only the two `kind` literals `dsh-host-webserver` knows are ever passed: its
 * implementation picks the route table with `kind === 'exact' ? exact : prefixes`
 * and validates nothing, so a typo would silently become a prefix route.
 * @param ctx - the Host plugin context.
 * @param host - the plugin's own read and write operations.
 */
export function registerRoutes(ctx: Context, host: RouteHost): void {
  ctx.inject(['webServer'], (inner) => {
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, label: string): void => {
      inner.effect(() => inner.webServer.register({ kind: 'exact', path, handler }), label)
    }

    /** Wrap a handler so a throw answers instead of escaping into the server. */
    const guard = (
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      what: string,
    ): (req: IncomingMessage, res: ServerResponse) => Promise<void> => {
      return async (req, res) => {
        if (!isSameOrigin(req)) {
          respond(res, 403, { error: 'cross-origin request refused' })
          return
        }
        try {
          await handler(req, res)
        } catch (error: unknown) {
          // Never echo request data back; the panel gets a stable sentence instead.
          ctx.logger.warn(`mail: ${what} failed: ${describe(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          // An offline mailbox is not a server fault, and the panel says so.
          if (errorCode(error) === 'account_offline') {
            respond(res, 503, { error: 'account offline', code: 'account_offline' })
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    register(PANEL_PATH, guard((_req, res) => {
      try {
        respondDocument(res, 200, host.panelDocument(), 'text/html; charset=utf-8', {
          'content-security-policy': PANEL_CSP,
        })
      } catch (error: unknown) {
        ctx.logger.warn(`mail: serving the panel failed: ${describe(error)}`)
        respondDocument(res, 500, `panel document unavailable: ${describe(error)}`, 'text/plain; charset=utf-8')
      }
    }, 'panel'), 'mail.panel-route')

    register(STATE_PATH, guard((req, res) => {
      const state = host.state()
      // Polling is what keeps the panel live, so the common case has to be cheap:
      // when the caller already holds this revision there is nothing to send but
      // the fact that nothing changed.
      const since = Number(queryOf(req).get('since'))
      if (Number.isSafeInteger(since) && since === state.revision) {
        respond(res, 200, { unchanged: true, revision: state.revision })
        return
      }
      respond(res, 200, state)
    }, 'reading state'), 'mail.state-route')

    register(MESSAGE_PATH, guard(async (req, res) => {
      const query = queryOf(req)
      const uid = Number(query.get('uid'))
      if (!query.get('accountId') || !query.get('folder') || !Number.isSafeInteger(uid) || uid <= 0) {
        respond(res, 400, { error: 'accountId, folder and a positive uid are required' })
        return
      }
      const detail = await host.detail(query.get('accountId') ?? '', query.get('folder') ?? '', uid)
      if (detail === undefined) {
        respond(res, 404, { error: 'message not found' })
        return
      }
      respond(res, 200, detail)
    }, 'reading a message'), 'mail.message-route')

    register(ATTACHMENT_PATH, guard(async (req, res) => {
      const query = queryOf(req)
      const uid = Number(query.get('uid'))
      const part = query.get('part')
      if (!query.get('accountId') || !query.get('folder') || !Number.isSafeInteger(uid) || uid <= 0 || !part) {
        respond(res, 400, { error: 'accountId, folder, a positive uid and a part are required' })
        return
      }
      const attachment = await host.attachment(query.get('accountId') ?? '', query.get('folder') ?? '', uid, part)
      if (attachment === undefined) {
        respond(res, 404, { error: 'attachment not found' })
        return
      }
      res.writeHead(200, {
        'content-type': attachment.contentType || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        'cache-control': 'no-store',
      })
      attachment.content.pipe(res)
      attachment.content.on('error', () => res.destroy())
    }, 'downloading an attachment'), 'mail.attachment-route')

    /** The two mutating routes differ only in which operation they run. */
    const mountMutation = (path: string, what: string, run: (input: unknown) => Promise<RouteResult>): void => {
      register(path, guard(async (req, res) => {
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
        const result = await run(body.value)
        respond(res, result.ok ? 200 : 400, result)
      }, what), `mail.${what}-route`)
    }

    mountMutation(ACTION_PATH, 'action', (input) => host.action(input))
    mountMutation(CONFIG_PATH, 'config', (input) => host.config(input))
    mountMutation(REFRESH_PATH, 'refresh', (input) => host.refresh(input))
    mountMutation(MORE_PATH, 'more', (input) => host.more(input))

  })
}

/** Parse one request's query string without trusting the request line. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** Describe any thrown value for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The failure code a thrown value carries, when it carries one. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
