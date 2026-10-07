/**
 * The skill catalog, one instruction body, and the two mutations: what the
 * Skills tab reads and steers.
 *
 * A dynamically loaded page receives only the configuration the Host serves, so
 * every skill fact arrives over the same origin that served this bundle. The
 * wire shapes are defined once, by the Host half: the two halves are one
 * package, so `../skill-catalog.ts`, `../skill-routes.ts`, and
 * `../skill-import.ts` are the same contracts the routes serialize. They are
 * reached as *types* only — nothing outside `src/client/**` belongs in the
 * browser bundle — so those imports are erased and the `is*` checks below stay
 * the only runtime validation.
 *
 * The mutating routes additionally demand the marks only this page's script can
 * make: {@link MUTATION_HEADER} plus a JSON content type. That constant is
 * spelled here rather than imported from `../http.ts`, which is Host code and
 * would drag the request guards into the bundle.
 *
 * @module @deepseek-ai/dsh-agent-import/client/agent-import-skills
 */
import type { SkillCandidate, SkillCatalog, SkillReport, SkillState } from '../skill-catalog.ts'
import type { SkillImportOutcome, SkillSkip, SkillSkipReason } from '../skill-import.ts'
import type { SkillSourceId } from '../skill-roots.ts'
import type { SkillContentReport } from '../skill-routes.ts'

export type { SkillCandidate, SkillCatalog, SkillReport, SkillState }
export type { SkillContentReport, SkillImportOutcome, SkillSkip, SkillSkipReason, SkillSourceId }

/** Header a mutating request must carry, mirroring the Host half's `../http.ts`. */
export const MUTATION_HEADER = 'x-dsh-agent-import'

/** Path the catalog route answers on. */
export const SKILLS_PATH = '/agent-import/skills'

/** Path the instruction-body route answers on. */
export const SKILL_CONTENT_PATH = '/agent-import/skills/content'

/** Path the import route answers on. */
export const SKILL_IMPORT_PATH = '/agent-import/skills/import'

/** Path the removal route answers on. */
export const SKILL_REMOVE_PATH = '/agent-import/skills/remove'

/** What one read of the catalog produced. */
export type SkillCatalogResult =
  | { readonly phase: 'ready'; readonly catalog: SkillCatalog }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly offline?: true }

/** What one read of an instruction body produced. */
export type SkillContentResult =
  | { readonly phase: 'ready'; readonly content: SkillContentReport }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly offline?: true }

/** What one import or removal produced. */
export type SkillMutationResult =
  | { readonly phase: 'ready'; readonly outcome: SkillImportOutcome }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly offline?: true }

/** One skill's instruction body to read. */
export interface SkillContentRequest {
  /** Name dsh addresses the skill by. */
  readonly name: string
  /** Which source's copy to read; omitted reads the installed copy, or the winner. */
  readonly source?: SkillSourceId
}

/** One skill to import. */
export interface SkillImportRequest {
  /** Name dsh addresses the skill by. */
  readonly name: string
  /** Source to import from; omitted imports the winning candidate. */
  readonly source?: SkillSourceId
  /** Whether to replace a link that currently points at another source. */
  readonly replace?: boolean
}

/**
 * Read the whole skill catalog.
 * @returns every skill name, its offerings, its installed state, and the scan's notes.
 */
export async function loadSkillCatalog(): Promise<SkillCatalogResult> {
  const answer = await read(SKILLS_PATH)
  if (!answer.ok) return failed(answer)
  if (!isCatalog(answer.body)) return failed({ reason: 'unexpected catalog payload' })
  return { phase: 'ready', catalog: answer.body }
}

/**
 * Read one skill's instruction body.
 * @param request - the skill name, and optionally which source's copy to read.
 * @returns the body and the file it was read from, or why it could not be read.
 */
export async function loadSkillContent(request: SkillContentRequest): Promise<SkillContentResult> {
  const query = new URLSearchParams({ name: request.name })
  if (request.source !== undefined) query.set('source', request.source)
  const answer = await read(`${SKILL_CONTENT_PATH}?${query.toString()}`)
  if (!answer.ok) return failed(answer)
  if (!isContent(answer.body)) return failed({ reason: 'unexpected content payload' })
  return { phase: 'ready', content: answer.body }
}

/**
 * Import one skill, from a chosen source or from the winning one.
 * @param request - the name to import, and optionally which source and whether to replace a link.
 * @returns what was imported, and what was left alone.
 */
export async function sendSkillImport(request: SkillImportRequest): Promise<SkillMutationResult> {
  return await mutate(SKILL_IMPORT_PATH, {
    name: request.name,
    ...request.source === undefined ? {} : { source: request.source },
    ...request.replace === undefined ? {} : { replace: request.replace },
  })
}

/**
 * Remove one import.
 * @param name - name dsh addresses the skill by.
 * @returns what was removed, and what was left alone.
 */
export async function sendSkillRemoval(name: string): Promise<SkillMutationResult> {
  return await mutate(SKILL_REMOVE_PATH, { name })
}

/** Why one route read produced nothing to render. */
interface ReadFailure {
  /** What to show the user. */
  readonly reason: string
  /** Set when the page never reached the Host, so the copy can name that instead. */
  readonly offline?: true
}

/** What one GET produced: the parsed body, or the reason to show instead. */
type ReadAnswer = { readonly ok: true; readonly body: unknown } | ({ readonly ok: false } & ReadFailure)

/**
 * Read one route, turning every way it can fail into a reason to display.
 *
 * A rejection is the page never reaching the Host; an unreadable body is the
 * route answering something other than JSON. Both land here so no caller has to
 * tell them apart.
 */
async function read(path: string): Promise<ReadAnswer> {
  let response: Response
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } })
  } catch (error: unknown) {
    return { ok: false, reason: message(error), offline: true }
  }
  if (!response.ok) return { ok: false, reason: await errorText(response) }
  try {
    return { ok: true, body: await response.json() }
  } catch (error: unknown) {
    return { ok: false, reason: message(error) }
  }
}

/**
 * Send one mutating request and read its outcome.
 *
 * The two marks the Host demands travel together: a custom header a cross-site
 * form cannot set, and a JSON content type.
 */
async function mutate(path: string, body: Readonly<Record<string, unknown>>): Promise<SkillMutationResult> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        [MUTATION_HEADER]: '1',
      },
      body: JSON.stringify(body),
    })
  } catch (error: unknown) {
    return { phase: 'unavailable', reason: message(error), offline: true }
  }
  if (!response.ok) return failed({ reason: await errorText(response) })
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error: unknown) {
    return failed({ reason: message(error) })
  }
  if (!isOutcomeAnswer(parsed)) return failed({ reason: 'unexpected outcome payload' })
  return { phase: 'ready', outcome: parsed.outcome }
}

/** Read the `error` a route answered with, falling back to its status. */
async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    const error = isObject(body) ? body['error'] : undefined
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    // A route that answers no JSON leaves its status as the only fact.
  }
  return `HTTP ${String(response.status)}`
}

/**
 * Carry one failed read into the phase the page shows.
 * @param failure - why the read produced nothing to render.
 * @returns the unavailable phase, marked offline when the Host was never reached.
 */
function failed(failure: ReadFailure): {
  readonly phase: 'unavailable'
  readonly reason: string
  readonly offline?: true
} {
  return {
    phase: 'unavailable',
    reason: failure.reason,
    ...failure.offline === true ? { offline: true } : {},
  }
}

/**
 * Whether a parsed body is the catalog this page renders.
 *
 * The body crosses the wire, so the check is deliberately shallow: it admits
 * only the values the page dereferences, and treats a row without a name as no
 * payload at all rather than rendering an entry with nothing in it.
 */
function isCatalog(value: unknown): value is SkillCatalog {
  return isObject(value)
    && Array.isArray(value['skills'])
    && value['skills'].every(isSkill)
    && isNames(value['notes'])
}

/** Whether a value is one catalog row the page can render. */
function isSkill(value: unknown): value is SkillReport {
  if (!isObject(value)) return false
  return typeof value['name'] === 'string'
    && typeof value['description'] === 'string'
    && isState(value['state'])
    && typeof value['conflict'] === 'boolean'
    && Array.isArray(value['candidates'])
    && value['candidates'].every(isCandidate)
    && isOptionalString(value['installedPath'])
    && isOptionalString(value['installedFile'])
    && isOptionalString(value['installedTarget'])
    && isOptionalString(value['installedSource'])
}

/** Whether a value is one offering the page can render. */
function isCandidate(value: unknown): value is SkillCandidate {
  if (!isObject(value)) return false
  return typeof value['source'] === 'string'
    && typeof value['label'] === 'string'
    && typeof value['path'] === 'string'
    && typeof value['file'] === 'string'
    && typeof value['winner'] === 'boolean'
}

/** Whether a value is one instruction body the page can render. */
function isContent(value: unknown): value is SkillContentReport {
  return isObject(value)
    && typeof value['name'] === 'string'
    && typeof value['file'] === 'string'
    && typeof value['content'] === 'string'
}

/** Whether a value is an answer carrying an outcome the page can render. */
function isOutcomeAnswer(value: unknown): value is { readonly outcome: SkillImportOutcome } {
  if (!isObject(value)) return false
  const outcome = value['outcome']
  return isObject(outcome)
    && isNames(outcome['imported'])
    && isNames(outcome['removed'])
    && isNames(outcome['notes'])
    && Array.isArray(outcome['skipped'])
    && outcome['skipped'].every(isSkip)
}

/** Whether a value is one name an operation left alone. */
function isSkip(value: unknown): value is SkillSkip {
  return isObject(value)
    && typeof value['name'] === 'string'
    && isSkipReason(value['reason'])
    && isOptionalString(value['detail'])
}

/**
 * Whether a value is one of the reasons an operation leaves a name alone.
 *
 * The page writes copy for each, so a reason this build does not know is no
 * outcome at all rather than a row with nothing to say about itself.
 */
function isSkipReason(value: unknown): value is SkillSkipReason {
  return value === 'already-installed'
    || value === 'local-copy'
    || value === 'no-source'
    || value === 'occupied'
    || value === 'unsupported'
    || value === 'not-a-link'
    || value === 'failed'
    || value === 'removed'
}

/**
 * Whether a value is one of the states a catalog row can be in.
 *
 * `disabled` is a state this page renders differently from `available`, so a
 * payload carrying it must be admitted here: refusing it would hide the whole
 * catalog over a row the user switched off themselves.
 */
function isState(value: unknown): value is SkillState {
  return value === 'available'
    || value === 'linked'
    || value === 'local'
    || value === 'broken'
    || value === 'disabled'
}

/** Whether a value is a list of strings. */
function isNames(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** Whether a value is absent or a string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Describe any thrown value for a reason line. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
