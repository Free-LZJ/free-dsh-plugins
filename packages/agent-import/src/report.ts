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
import { isSameOrigin, respond } from './http.ts'

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
  /** Skills dsh's own root holds: the imports this plugin linked, and anything placed there by hand. */
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

