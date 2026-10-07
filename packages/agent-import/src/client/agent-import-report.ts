/**
 * The import report the host half answers with, and the read that fetches it.
 *
 * A dynamically loaded card receives only the configuration the Host serves, so
 * what the current import generation actually mounted, and what dsh's own
 * directory now holds, arrives over the same origin that served this bundle.
 *
 * The wire shape is defined once, by the Host half: the two halves are one
 * package, so `../report.ts` is the same contract the route serializes. It is
 * reached as a *type* only — nothing outside `src/client/**` belongs in the
 * browser bundle, so the import is erased and `isReport` below stays the only
 * runtime check.
 */
import type { AgentImportReport } from '../report.ts'

export type { AgentImportReport }

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
