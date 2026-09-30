/**
 * The import report the host half publishes, and the read that fetches it.
 *
 * A dynamically loaded card receives only the configuration the Host serves, so
 * what the current import generation actually mounted and published arrives
 * over the same origin that served this bundle. The types are spelled here
 * rather than imported from the host package: a client package must not depend
 * on a Host package.
 */

/** One skill the host half reports as published. */
export interface ReportedSkill {
  /** Skill name callers address it by. */
  readonly name: string
  /** One-line description from the skill's own frontmatter. */
  readonly description: string
  /** Tool whose directory the skill came from. */
  readonly source: string
  /** Absolute path of the skill's instruction file. */
  readonly path: string
}

/** One MCP server the host half reports as planned. */
export interface ReportedServer {
  /** Server name as the declaring tool writes it. */
  readonly name: string
  /** dsh server namespace it mounts under; absent when the plan skipped the server. */
  readonly serverName?: string
  /** Transport the declaration uses. */
  readonly transport: string
  /** Executable or endpoint the server runs. */
  readonly target: string
  /** Tool whose configuration declared the server. */
  readonly source: string
  /** Whether the generation mounted the server, or why it did not. */
  readonly status: 'mounted' | 'skipped'
  /** The bound or list entry that left a skipped server unmounted. */
  readonly reason?: string
}

/** What the current import generation mounted and published. */
export interface AgentImportReport {
  /** ISO instant the reported generation was built; empty when none is active. */
  readonly importedAt: string
  /** Tools the generation read, in precedence order. */
  readonly sources: readonly string[]
  /** Skills the generation publishes. */
  readonly skills: readonly ReportedSkill[]
  /** Servers the generation planned, in declaration order. */
  readonly servers: readonly ReportedServer[]
  /** Declarations and files the import could not use. */
  readonly notes: readonly string[]
}

/** What one read of the report produced. */
export type AgentImportReportResult =
  | { readonly phase: 'ready'; readonly report: AgentImportReport }
  | { readonly phase: 'unavailable'; readonly reason: string }

/** Path the host half answers the report on. */
const REPORT_PATH = '/agent-import/report'

/**
 * Read the host half's import report.
 * @returns the report, or why this page cannot show one.
 */
export async function loadAgentImportReport(): Promise<AgentImportReportResult> {
  try {
    const response = await fetch(REPORT_PATH, { headers: { accept: 'application/json' } })
    if (!response.ok) return { phase: 'unavailable', reason: `HTTP ${String(response.status)}` }
    const body: unknown = await response.json()
    if (!isReport(body)) return { phase: 'unavailable', reason: 'unexpected report payload' }
    return { phase: 'ready', report: body }
  } catch (error: unknown) {
    return { phase: 'unavailable', reason: String(error) }
  }
}

/**
 * Whether a parsed response body is the report this card renders.
 *
 * The body crosses the wire, so the check is deliberately shallow: it admits
 * only the values the card dereferences, and treats a row without a name as no
 * payload at all rather than rendering an entry with nothing in it.
 * @param value - the parsed response body.
 * @returns true when the body carries every field the card reads.
 */
function isReport(value: unknown): value is AgentImportReport {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof AgentImportReport, unknown>>
  return typeof candidate.importedAt === 'string'
    && isNames(candidate.sources)
    && isNames(candidate.notes)
    && isRows(candidate.skills)
    && isRows(candidate.servers)
}

/** Whether a value is a list of strings. */
function isNames(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** Whether a value is a list of report rows, each carrying the name every row renders. */
function isRows(value: unknown): boolean {
  return Array.isArray(value)
    && value.every(entry => typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string')
}
