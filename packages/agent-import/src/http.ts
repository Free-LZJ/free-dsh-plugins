/**
 * The small HTTP surface the settings routes share.
 *
 * These routes sit beside the harness's own routes rather than inside the API
 * gateway's session check, so each one guards itself. A read must come from the
 * page this server sent; a write must additionally carry a header a cross-site
 * form cannot set, and declare itself JSON, which is what keeps another origin
 * from steering an import or a removal through the user's browser.
 *
 * @module @deepseek-ai/dsh-agent-import/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Header a mutating request must carry, together with a JSON content type. */
export const MUTATION_HEADER = 'x-dsh-agent-import'

/** Largest request body a route reads; every payload here is a name or two. */
export const MAX_BODY_BYTES = 64 * 1024

/** What reading a request body produced. */
export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

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
 * @returns true when the request may change what is installed.
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
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'request body too large' }
      chunks.push(buffer)
    }
  } catch (error: unknown) {
    return { ok: false, status: 400, error: `unreadable request body: ${message(error)}` }
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
 * Answer one request with a JSON body and no caching.
 * @param res - the response to own.
 * @param status - HTTP status to answer with.
 * @param payload - value to serialize.
 */
export function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Describe any thrown value for an answer body. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
