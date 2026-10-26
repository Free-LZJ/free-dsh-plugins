/**
 * The HTTP surface the browser's Worktree dialog speaks to.
 *
 * These routes sit beside the harness's own rather than inside the API
 * gateway's session check, and `dsh-host-webserver` adds no middleware, body
 * parsing or origin policy of its own — so every guard is stated here: a read
 * must come from the page this server sent, and a write must additionally carry
 * a header a cross-site form cannot set.
 *
 * @module @free-lzj/dsh-worktree/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createWorktree } from './git.ts'
import {
  CREATE_PATH, MAX_BODY_BYTES, MUTATION_HEADER, type CreateWorktreeRequest,
} from './protocol.ts'

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot reach these routes through the user's browser.
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
 * @returns true when the request may create a worktree.
 */
export function isMutationRequest(req: IncomingMessage): boolean {
  if (req.headers[MUTATION_HEADER] !== '1') return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

/**
 * Mount the one route this plugin needs.
 * @param ctx - the Host plugin context.
 */
export function registerRoutes(ctx: Context): void {
  ctx.inject(['webServer'], (inner) => {
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: CREATE_PATH,
      // The promise is returned so the server (and a spec framing the route)
      // can see when this answer finished, rather than fire-and-forget.
      handler: (req, res) => handleCreate(ctx, req, res),
    }), 'worktrees.create-route')
  })
}

/**
 * Answer one create request.
 * @param ctx - the Host plugin context, for logging.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function handleCreate(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isSameOrigin(req)) {
    respond(res, 403, { error: 'cross-origin request refused' })
    return
  }
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
  const request = readCreateRequest(body.value)
  if (!request.ok) {
    respond(res, 400, { error: request.error })
    return
  }
  try {
    respond(res, 200, await createWorktree(request.value.dir, request.value.name))
  } catch (error: unknown) {
    // The message is this plugin's own sentence about a repository it may not
    // be able to change; it never echoes the request body back verbatim.
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`worktrees: create failed: ${message}`)
    respond(res, 400, { error: message })
  }
}

/** One accepted create request. */
type CreateCommand =
  | { readonly ok: true; readonly value: CreateWorktreeRequest }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one create payload before Git runs.
 * @param value - the parsed JSON body.
 * @returns the request, or why it was refused.
 */
function readCreateRequest(value: unknown): CreateCommand {
  const body = (value ?? {}) as Record<string, unknown>
  if (typeof body.dir !== 'string' || body.dir.trim() === '') {
    return { ok: false, error: 'dir must be a non-empty path' }
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return { ok: false, error: 'name must be a string when present' }
  }
  return { ok: true, value: { dir: body.dir, ...body.name === undefined ? {} : { name: body.name } } }
}

/** What reading a request body produced. */
type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * Read a bounded JSON body.
 * @param req - the incoming request.
 * @returns the parsed value, or the status and message to answer with.
 */
async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
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
