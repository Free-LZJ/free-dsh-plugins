/**
 * The routes the settings page reads and steers imports through.
 *
 * Three of them: one answering the whole catalog, one answering a single
 * skill's instruction body for the detail view, and one mutating route that
 * imports or removes. Only the mutation route changes anything, and it demands
 * the marks only this page's own script can make; every route verifies it is
 * answering that page before it does anything.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-routes
 */

import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMutationRequest, isSameOrigin, readJsonBody, respond } from './http.ts'
import { readSkillFile } from './skill-file.ts'
import type { SkillCatalog, SkillReport } from './skill-catalog.ts'
import type { SkillImportOutcome, SkillImportRequest } from './skill-import.ts'
import type { SkillSourceId } from './skill-roots.ts'

/** Path the catalog route answers on. */
export const SKILLS_PATH = '/agent-import/skills'

/** Path the instruction-body route answers on. */
export const SKILL_CONTENT_PATH = '/agent-import/skills/content'

/** Path the import route answers on. */
export const SKILL_IMPORT_PATH = '/agent-import/skills/import'

/** Path the removal route answers on. */
export const SKILL_REMOVE_PATH = '/agent-import/skills/remove'

/** Largest instruction body the detail view displays, before it says so instead. */
export const MAX_CONTENT_BYTES = 256 * 1024

/** One skill's instruction body, as the detail view reads it. */
export interface SkillContentReport {
  /** Name the skill declares. */
  readonly name: string
  /** One-line description the skill declares. */
  readonly description: string
  /** Where the body was read from, when the source is one this catalog knows. */
  readonly source?: SkillSourceId
  /** Absolute path of the file the body was read from. */
  readonly file: string
  /** Instruction body with the frontmatter removed. */
  readonly content: string
}

/** What the routes need from the plugin to do their work. */
export interface SkillRouteOperations {
  /** Build the current catalog; called once per request. */
  readonly catalog: () => Promise<SkillCatalog>
  /** Import one skill, or replace its link. */
  readonly importSkill: (request: SkillImportRequest) => Promise<SkillImportOutcome>
  /** Remove one import. */
  readonly removeSkill: (name: string) => Promise<SkillImportOutcome>
}

/** One answer body for either mutating route. */
interface MutationAnswer {
  readonly outcome?: SkillImportOutcome
  readonly error?: string
}

/**
 * Build the handler that answers the whole catalog.
 * @param operations - where the catalog comes from.
 * @returns the route handler, which owns the full response lifecycle.
 */
export function createSkillsHandler(
  operations: SkillRouteOperations,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isRead(req)) {
      respond(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req)) {
      respond(res, 403, { error: 'forbidden' })
      return
    }
    try {
      respond(res, 200, await operations.catalog())
    } catch (error: unknown) {
      respond(res, 500, { error: String(error) })
    }
  }
}

/**
 * Build the handler that answers one skill's instruction body.
 * @param operations - where the catalog comes from.
 * @returns the route handler, which owns the full response lifecycle.
 */
export function createSkillContentHandler(
  operations: SkillRouteOperations,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isRead(req)) {
      respond(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req)) {
      respond(res, 403, { error: 'forbidden' })
      return
    }
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const name = query.get('name') ?? ''
    if (name.length === 0) {
      respond(res, 400, { error: 'name is required' })
      return
    }
    const source = query.get('source')
    try {
      const catalog = await operations.catalog()
      const content = await readSkillContent(catalog, { name, ...source === null ? {} : { source: source as SkillSourceId } })
      if (typeof content === 'string') {
        respond(res, 404, { error: content })
        return
      }
      respond(res, 200, content)
    } catch (error: unknown) {
      respond(res, 500, { error: String(error) })
    }
  }
}

/**
 * Build the handler for one mutating action.
 * @param operations - the import and removal operations to call.
 * @param action - which action this route performs.
 * @returns the route handler, which owns the full response lifecycle.
 */
export function createSkillMutationHandler(
  operations: SkillRouteOperations,
  action: 'import' | 'remove',
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req) || !isMutationRequest(req)) {
      respond(res, 403, { error: 'forbidden' })
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      respond(res, body.status, { error: body.error })
      return
    }
    const request = readMutation(body.value, action)
    if (typeof request === 'string') {
      respond(res, 400, { error: request })
      return
    }
    try {
      const outcome = action === 'import'
        ? await operations.importSkill(request as SkillImportRequest)
        : await operations.removeSkill((request as SkillImportRequest).name)
      const answer: MutationAnswer = { outcome }
      respond(res, 200, answer)
    } catch (error: unknown) {
      respond(res, 500, { error: String(error) })
    }
  }
}

/**
 * Read one skill's instruction body.
 *
 * The installed copy wins over any offering, because that is the copy dsh
 * actually loads; a caller that named a source reads that source instead, which
 * is how the page shows what a different import would bring.
 * @param catalog - the catalog to resolve the name against.
 * @param request - the skill name, and optionally which source to read.
 * @returns the body, or the reason it could not be read.
 */
export async function readSkillContent(
  catalog: SkillCatalog,
  request: { readonly name: string; readonly source?: SkillSourceId },
): Promise<SkillContentReport | string> {
  const skill = catalog.skills.find(entry => entry.name === request.name)
  if (skill === undefined) return `no skill named ${request.name}`
  const chosen = request.source === undefined
    ? undefined
    : skill.candidates.find(candidate => candidate.source === request.source)
  if (request.source !== undefined && chosen === undefined) return `${request.name} has no ${request.source} copy`
  const file = chosen?.file ?? skill.installedFile ?? skill.candidates.find(candidate => candidate.winner)?.file
  if (file === undefined) return `${request.name} has no readable instruction file`
  const size = await fileSize(file)
  if (size !== undefined && size > MAX_CONTENT_BYTES) return `${file} is too large to display (${size} bytes)`
  const parsed = await readSkillFile(file)
  if (typeof parsed === 'string') return `${file} could not be read: ${parsed}`
  const source = chosen?.source ?? installedSourceOf(skill)
  return {
    name: parsed.name,
    description: parsed.description,
    ...source === undefined ? {} : { source },
    file,
    content: parsed.content,
  }
}

/** Attribute an installed-only row to the source its link points into. */
function installedSourceOf(skill: SkillReport): SkillSourceId | undefined {
  return skill.installedSource ?? skill.candidates.find(candidate => candidate.winner)?.source
}

/** Read a file's size, treating an absent file as unknown rather than fatal. */
async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

/** Whether a request is one of the read methods these routes answer. */
function isRead(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD'
}

/**
 * Validate one mutating request body.
 * @param value - the parsed JSON value.
 * @param action - which action this route performs.
 * @returns the request to run, or the reason the body is unusable.
 */
function readMutation(value: unknown, action: 'import' | 'remove'): { name: string; source?: SkillSourceId; replace?: boolean } | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'body must be a JSON object'
  const record = value as Record<string, unknown>
  const name = record['name']
  if (typeof name !== 'string' || name.trim().length === 0) return 'name must be a non-empty string'
  if (name.length > 200) return 'name is too long'
  if (action === 'remove') return { name: name.trim() }
  const source = record['source']
  if (source !== undefined && (typeof source !== 'string' || source.length > 64)) return 'source must be a string'
  const replace = record['replace']
  if (replace !== undefined && typeof replace !== 'boolean') return 'replace must be a boolean'
  return {
    name: name.trim(),
    ...source === undefined ? {} : { source: source as SkillSourceId },
    ...replace === undefined ? {} : { replace },
  }
}
