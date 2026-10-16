/**
 * The DSH home directory, explained — Host half.
 *
 * `~/.dsh` is the one directory a reinstall has to be careful with, and nothing
 * in the product says what each entry in it is. This plugin answers that from a
 * panel of its own: what every entry holds, what a reinstall should keep, and a
 * read-only look at the small text files, with credential values never leaving
 * this process.
 *
 * The panel is a self-contained document rather than React, because it is a
 * tree with three layouts, drag-reorderable columns, and a preview dialog — the
 * kind of thing a document does in a hundred lines and a component tree does in
 * a thousand. This half owns the data and serves the document; the browser half
 * owns the sidebar entry that shows it.
 *
 * @module @free-lzj/dsh-directory-guide
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readSnapshot } from './snapshot.ts'

export { readSnapshot, dshHome, redact } from './snapshot.ts'
export type { Snapshot, SnapshotNode, TopNoteRow } from './snapshot.ts'
export { TOP_NOTES, annotate } from './notes.ts'
export type { Advice, TopNote } from './notes.ts'

/** Route the panel reads its payload from. */
export const SNAPSHOT_PATH = '/dsh-directory-guide/snapshot'

/** Route the panel document itself is served on. */
export const PANEL_PATH = '/dsh-directory-guide/panel'

/**
 * The panel document inside this package.
 *
 * The file sits at the package root, while this module is bundled either at
 * `lib/index.js` or, before bundling, at `lib/types/index.js` — so both
 * candidate roots are tried rather than assuming one depth.
 * @returns absolute path to the panel document.
 */
function panelDocumentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, '..', 'assets', 'panel.html')
  return existsSync(bundled) ? bundled : join(here, '..', '..', 'assets', 'panel.html')
}

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot read the user's home-directory listing through their
 * browser.
 * @param req - the incoming request.
 * @returns true when the request comes from this server's own page.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Answer with a body and no caching.
 * @param res - the response to own.
 * @param status - HTTP status to answer with.
 * @param contentType - media type of the body.
 * @param body - the body, already serialized.
 * @param extraHeaders - headers this answer must also carry.
 */
function respond(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
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
 * Mount the two routes the panel needs.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (inner) => {
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: SNAPSHOT_PATH,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (!isSameOrigin(req)) {
          respond(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'cross-origin request refused' }))
          return
        }
        try {
          respond(res, 200, 'application/json; charset=utf-8', JSON.stringify(readSnapshot()))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`directory-guide: reading ${dshHomeLabel()} failed: ${message}`)
          respond(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: message }))
        }
      },
    }), 'directory-guide.snapshot-route')

    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: PANEL_PATH,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (!isSameOrigin(req)) {
          respond(res, 403, 'text/plain; charset=utf-8', 'cross-origin request refused')
          return
        }
        try {
          const html = readFileSync(panelDocumentPath(), 'utf8')
          // The document may fetch its own snapshot route and nothing else, and
          // the header is stated here so the served page depends on no meta tag.
          respond(res, 200, 'text/html; charset=utf-8', html, {
            'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
          })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`directory-guide: serving the panel failed: ${message}`)
          respond(res, 500, 'text/plain; charset=utf-8', `panel document unavailable: ${message}`)
        }
      },
    }), 'directory-guide.panel-route')
  })
}

/** The directory being described, for log lines. */
function dshHomeLabel(): string {
  return process.env.DSH_HOME ?? '~/.dsh'
}
