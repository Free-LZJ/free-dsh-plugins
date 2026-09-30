/**
 * The import report, and the same-origin route that serves it to the settings
 * card.
 *
 * The card is a browser half and cannot read host state, so the host half
 * publishes what the current import generation mounted and published. The
 * payload carries names and locations only: a server's arguments, environment
 * entries, and headers stay out, because this route sits beside the harness's
 * own routes rather than inside the API gateway's session check.
 *
 * @module @deepseek-ai/dsh-agent-import/report
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Path the report route answers on. */
export const REPORT_PATH = '/agent-import/report'

/** One skill the current import generation publishes. */
export interface ImportedSkillReport {
  /** Skill name callers address it by. */
  readonly name: string
  /** One-line description from the skill's own frontmatter. */
  readonly description: string
  /** Tool whose directory the skill came from. */
  readonly source: string
  /** Absolute path of the skill's instruction file. */
  readonly path: string
}

/** One MCP server the current import generation planned. */
export interface ImportedServerReport {
  /** Server name as the declaring tool writes it. */
  readonly name: string
  /** dsh server namespace it mounts under; absent when the plan skipped the server. */
  readonly serverName?: string
  /** Transport the declaration uses. */
  readonly transport: string
  /** Executable or endpoint the server runs; never its arguments, environment, or headers. */
  readonly target: string
  /** Tool whose configuration declared the server. */
  readonly source: string
  /** Whether the generation mounted the server, or why it did not. */
  readonly status: 'mounted' | 'skipped'
  /** The bound or list entry that left a skipped server unmounted. */
  readonly reason?: string
}

/** What the settings card reads back from the host half. */
export interface AgentImportReport {
  /** ISO instant the reported generation was built; empty when no generation is active. */
  readonly importedAt: string
  /** Tools the generation read, in precedence order. */
  readonly sources: readonly string[]
  /** Skills the generation publishes, as its provider lists them now. */
  readonly skills: readonly ImportedSkillReport[]
  /** Servers the generation planned, in declaration order. */
  readonly servers: readonly ImportedServerReport[]
  /** Declarations and files the import could not use, as human-readable lines. */
  readonly notes: readonly string[]
}

/** The report of a deployment whose import generation failed to build. */
export const NO_REPORT: AgentImportReport = { importedAt: '', sources: [], skills: [], servers: [], notes: [] }

/**
 * Build the handler that answers the report.
 * @param read - builds the current report; called once per request, so the answer follows the live generation.
 * @returns the route handler, which owns the full response lifecycle.
 */
export function createReportHandler(
  read: () => Promise<AgentImportReport>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req)) {
      respond(res, 403, { error: 'forbidden' })
      return
    }
    let body: string
    try {
      body = JSON.stringify(await read())
    } catch (error: unknown) {
      // The route owns its response: a read that fails answers, never leaves the request open.
      respond(res, 500, { error: String(error) })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

/**
 * Whether a request came from the page this server sent, so a document on
 * another origin cannot read the report through the user's browser.
 *
 * A browser states the relationship in `Sec-Fetch-Site`; a request that
 * carries no such header is not a cross-site document request (a local client,
 * or an older browser), and one that states `same-origin` or `none` is the
 * harness's own page or a direct navigation. Any stated `Origin` must still
 * name the host the request was addressed to.
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
    // An unparseable Origin is not this server's own page.
    return false
  }
}

/** Answer one request with a JSON body and no caching. */
function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
