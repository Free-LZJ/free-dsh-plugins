/**
 * The routing table: the data half of the workbench's rules.
 *
 * The design brief's rule shape is "deterministic shell + judgement core +
 * routing table": the classifier judges, this table decides. The table is a
 * JSON document, not code — changing a route is editing data, and the store
 * below re-reads the file when it changes, so a route edit needs no restart
 * (hot reload). A malformed edit never takes the board down: the store keeps
 * the last good table and warns, and the next read retries the file.
 *
 * Routing itself is a pure function of a classification and a table, which is
 * what makes every card's decision auditable: the card stores the decision,
 * the rule id and the table version, so a routing change can be replayed
 * against the same events later.
 *
 * @module @free-lzj/dsh-console/workbench/routing
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RoutingDecision, WorkbenchAction, WorkbenchClassification } from '../protocol.ts'

/** Confidence at or above which routing may dispatch automatically. */
export const AUTO_DISPATCH_CONFIDENCE = 0.6

/** One route: which classifications it claims, and what happens to them. */
export interface RouteRule {
  /** Stable id stored on the card's decision. */
  readonly id: string
  /** Kinds this route claims; absent means every kind. */
  readonly kinds?: readonly string[]
  /** Sources this route claims; absent means every source. */
  readonly sources?: readonly string[]
  /** Minimum confidence this route requires; defaults to the auto-dispatch threshold. */
  readonly minConfidence?: number
  readonly action: WorkbenchAction
  /** Executor a dispatch routes to; absent means the classification's suggestion. */
  readonly executor?: string
}

/** The routing document: a version plus an ordered, first-match-wins rule list. */
export interface RoutingTable {
  readonly version: string
  readonly rules: readonly RouteRule[]
}

/** The table v0 ships with: bugs to DSH, requirements to Codex, consults held for a reply. */
export function defaultRoutingTable(): RoutingTable {
  return {
    version: 'workbench-routes-v1',
    rules: [
      { id: 'bug-to-dsh', kinds: ['bug'], action: 'dispatch', executor: 'dsh' },
      { id: 'requirement-to-codex', kinds: ['requirement'], action: 'dispatch', executor: 'codex' },
      { id: 'consult-reply-only', kinds: ['consult'], action: 'reply-only' },
    ],
  }
}

/**
 * Route one classification.
 *
 * Low confidence always holds first — no rule may override the overflow pool,
 * because an automatic dispatch on a guess is the failure the threshold
 * exists to prevent. Otherwise the first matching rule wins; nothing matches
 * means hold, never dispatch.
 * @param classification - the classifier's verdict.
 * @param table - the routing table in force.
 * @param source - the event's source, for source-scoped rules.
 * @returns the auditable decision.
 */
export function routeEvent(
  classification: WorkbenchClassification,
  table: RoutingTable,
  source: string,
): RoutingDecision {
  if (classification.confidence < AUTO_DISPATCH_CONFIDENCE) {
    return {
      action: 'hold',
      routeId: 'low-confidence',
      ruleVersion: table.version,
      classification,
      reasons: [
        ...classification.reasons,
        { code: 'route-low-confidence', params: { confidence: classification.confidence, threshold: AUTO_DISPATCH_CONFIDENCE } },
      ],
    }
  }
  for (const rule of table.rules) {
    if (rule.kinds !== undefined && !rule.kinds.includes(classification.kind)) continue
    if (rule.sources !== undefined && !rule.sources.includes(source)) continue
    if (classification.confidence < (rule.minConfidence ?? AUTO_DISPATCH_CONFIDENCE)) continue
    const executor = rule.executor ?? classification.executor
    return {
      action: rule.action,
      ...(executor === undefined ? {} : { executor }),
      routeId: rule.id,
      ruleVersion: table.version,
      classification,
      reasons: [...classification.reasons, { code: 'route-matched', params: { route: rule.id } }],
    }
  }
  return {
    action: 'hold',
    routeId: 'no-route',
    ruleVersion: table.version,
    classification,
    reasons: [...classification.reasons, { code: 'route-none' }],
  }
}

/**
 * The routing table on disk, re-read when the file changes.
 *
 * `filePath` may be undefined (tests, or a deployment that wants the built-in
 * table only), in which case the fallback is the whole store. A read that
 * fails — missing file, malformed JSON, wrong shape — keeps the last good
 * table and warns through `warn`, so a half-written edit cannot break routing.
 */
export class RoutingTableStore {
  private currentTable: RoutingTable
  private mtimeMs = -1
  private warnedForMtime = -1

  /**
   * @param filePath - routing document path, or undefined for the built-in table.
   * @param fallback - the table used before any file is read.
   * @param warn - where a rejected edit is reported.
   */
  constructor(
    private readonly filePath: string | undefined,
    fallback: RoutingTable,
    private readonly warn: (message: string) => void,
  ) {
    this.currentTable = fallback
  }

  /**
   * The table in force, re-reading the file when it changed.
   * @returns the routing table.
   */
  async current(): Promise<RoutingTable> {
    if (this.filePath === undefined) return this.currentTable
    let mtimeMs: number
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs
    } catch {
      // No file yet: the built-in table stands until one appears.
      return this.currentTable
    }
    if (mtimeMs === this.mtimeMs) return this.currentTable
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      this.currentTable = normalizeTable(parsed)
      this.mtimeMs = mtimeMs
    } catch (error: unknown) {
      // Warn once per file version: a persistent bad edit must not spam the log
      // on every event while still being visible.
      if (this.warnedForMtime !== mtimeMs) {
        this.warnedForMtime = mtimeMs
        this.warn(`workbench: ignoring malformed routing table: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.currentTable
  }

  /**
   * Write the fallback table when no file exists yet, so a user finds an
   * editable document instead of an absent one. Best effort; a failure only
   * means the built-in table keeps serving.
   * @param fallback - the table to write.
   */
  async ensureFile(fallback: RoutingTable): Promise<void> {
    if (this.filePath === undefined) return
    try {
      await stat(this.filePath)
    } catch {
      try {
        // The directory may not exist yet on a fresh home: the board's own
        // document creates it on its first write, but this file must not wait
        // for that — a user should find an editable table right after mount.
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, `${JSON.stringify(fallback, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        this.mtimeMs = -1
      } catch {
        // The built-in table still serves; the file is a convenience, not a need.
      }
    }
  }
}

/**
 * Accept only a document shaped like a routing table; anything else is a bad
 * edit, not a table.
 * @param value - the parsed document.
 * @returns the table.
 */
function normalizeTable(value: unknown): RoutingTable {
  const candidate = (value ?? {}) as Record<string, unknown>
  if (typeof candidate.version !== 'string' || !Array.isArray(candidate.rules)) {
    throw new Error('routing table needs a string version and a rules array')
  }
  const rules: RouteRule[] = []
  for (const entry of candidate.rules as unknown[]) {
    const rule = (entry ?? {}) as Record<string, unknown>
    if (typeof rule.id !== 'string' || (rule.action !== 'dispatch' && rule.action !== 'hold' && rule.action !== 'reply-only')) {
      throw new Error('each routing rule needs a string id and a valid action')
    }
    rules.push({
      id: rule.id,
      ...(Array.isArray(rule.kinds) && rule.kinds.every((kind) => typeof kind === 'string')
        ? { kinds: rule.kinds as string[] }
        : {}),
      ...(Array.isArray(rule.sources) && rule.sources.every((source) => typeof source === 'string')
        ? { sources: rule.sources as string[] }
        : {}),
      ...(typeof rule.minConfidence === 'number' ? { minConfidence: rule.minConfidence } : {}),
      action: rule.action,
      ...(typeof rule.executor === 'string' ? { executor: rule.executor } : {}),
    })
  }
  return { version: candidate.version, rules }
}
