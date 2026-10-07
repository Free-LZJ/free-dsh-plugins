/**
 * Importing another agent's skill into dsh's own root, and taking it back out.
 *
 * An import is one link from `~/.dsh/skills/<name>` to the directory the other
 * agent keeps its skill in. Nothing is copied, so the other agent stays the one
 * place that skill lives, and removing an import removes the link and nothing
 * else. A skill this package did not put there — a real directory someone made,
 * or a link they made by hand — is left exactly as it is.
 *
 * Every mutation runs one at a time through {@link exclusive}: two requests that
 * both decided to import the same name must not race to create the same link,
 * and one that removes a name must not run between another's check and create.
 *
 * A removal is also a decision about the future: it is written to
 * {@link skillStatePath}, so the automatic import that runs on the next
 * activation leaves that name alone instead of putting it back. Importing the
 * name again withdraws the decision.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-import
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildSkillCatalog, type SkillCandidate, type SkillReport } from './skill-catalog.ts'
import { createSkillLink, readEntryKind, removeSkillLink, SkillLinkError } from './skill-links.ts'
import { readSkillState, skillStatePath, withDecision, writeSkillState } from './skill-state.ts'
import type { ResolvedSkillRoot, SkillSourceId } from './skill-roots.ts'

/** Why one name was left alone. */
export type SkillSkipReason =
  /** A link is already in place for this name. */
  | 'already-installed'
  /** A real directory in a dsh root owns this name; imports never replace it. */
  | 'local-copy'
  /** The user removed this name, so automatic import leaves it alone. */
  | 'removed'
  /** No enabled source offers this name. */
  | 'no-source'
  /** Something already sits at the link path. */
  | 'occupied'
  /** This platform cannot link that kind of entry without copying it. */
  | 'unsupported'
  /** The path is not a link, so removing it could delete real files. */
  | 'not-a-link'
  /** The filesystem refused the operation. */
  | 'failed'

/** One name an operation deliberately did not touch. */
export interface SkillSkip {
  /** Skill name the operation was about. */
  readonly name: string
  /** Why it was left alone. */
  readonly reason: SkillSkipReason
  /** Detail worth showing, such as the filesystem message. */
  readonly detail?: string
}

/** What one import, removal, or synchronization did. */
export interface SkillImportOutcome {
  /** Names now linked into a dsh root by this operation. */
  readonly imported: readonly string[]
  /** Names whose link this operation removed. */
  readonly removed: readonly string[]
  /** Names this operation deliberately left alone. */
  readonly skipped: readonly SkillSkip[]
  /** Everything else worth reporting, as human-readable lines. */
  readonly notes: readonly string[]
}

/** Bounds one catalog build, and says where decisions are remembered. */
export interface SkillImportOptions {
  /** Most skills to read in total. */
  readonly maxSkills: number
  /**
   * File remembering which names the user removed; absent keeps no decisions,
   * which is right for a caller that is only reading the catalog.
   */
  readonly statePath?: string
}

/** One requested import. */
export interface SkillImportRequest {
  /** Name dsh addresses the skill by. */
  readonly name: string
  /** Source to import from; defaults to the winning candidate. */
  readonly source?: SkillSourceId
  /** Whether to replace a link that currently points at another source. */
  readonly replace?: boolean
}

/**
 * Import every skill the enabled sources offer that dsh does not have yet.
 *
 * This is what runs when the plugin loads, so it only ever adds: a name that is
 * already installed, owned by a real directory, or one the user removed before
 * is left alone and reported.
 * @param roots - resolved roots in precedence order, including the writable dsh root.
 * @param options - bounds for the scan, and where removed names are remembered.
 * @returns what was imported, and what was left alone.
 */
export async function syncSkills(
  roots: readonly ResolvedSkillRoot[],
  options: SkillImportOptions,
): Promise<SkillImportOutcome> {
  return await exclusive(async () => {
    const catalog = await buildSkillCatalog(roots, options)
    const skipped: SkillSkip[] = []
    const imported: string[] = []
    const notes = [...catalog.notes]
    const removed = await readRemoved(options)
    const conflicts = catalog.skills.filter(skill => skill.conflict)
    if (conflicts.length > 0) {
      // The winner was imported, but the user still has to know that another
      // tool serves the same name, because that is a choice this run made.
      notes.push(`${conflicts.length} skill name(s) are served by more than one source: ${conflicts.slice(0, 10).map(skill => skill.name).join(', ')}${conflicts.length > 10 ? ', …' : ''}`)
    }
    for (const skill of catalog.skills) {
      if (skill.state === 'local') {
        skipped.push({ name: skill.name, reason: 'local-copy' })
        continue
      }
      if (skill.state === 'linked') {
        skipped.push({ name: skill.name, reason: 'already-installed' })
        continue
      }
      if (skill.state === 'broken') {
        skipped.push({ name: skill.name, reason: 'failed', detail: 'its link no longer resolves' })
        continue
      }
      if (removed.has(skill.name)) {
        // Checked after the states above, because a name that is linked again
        // is linked whatever the file says, and reporting that is more useful.
        skipped.push({ name: skill.name, reason: 'removed' })
        continue
      }
      const result = await install(roots, skill, skill.candidates.find(candidate => candidate.winner))
      if (result.skip !== undefined) skipped.push({ name: skill.name, ...result.skip })
      else imported.push(skill.name)
    }
    return { imported, removed: [], skipped, notes }
  })
}

/**
 * Import one skill, from a chosen source or from the winning one.
 * @param roots - resolved roots in precedence order.
 * @param options - bounds for the scan.
 * @param request - the name to import, and optionally which source and whether to replace a link.
 * @returns what was imported, and what was left alone.
 */
export async function importSkill(
  roots: readonly ResolvedSkillRoot[],
  options: SkillImportOptions,
  request: SkillImportRequest,
): Promise<SkillImportOutcome> {
  return await exclusive(async () => {
    const catalog = await buildSkillCatalog(roots, options)
    const skill = catalog.skills.find(candidate => candidate.name === request.name)
    if (skill === undefined) {
      return { imported: [], removed: [], skipped: [{ name: request.name, reason: 'no-source' }], notes: catalog.notes }
    }
    const source = request.source
    const candidate = source === undefined
      ? skill.candidates.find(entry => entry.winner)
      : skill.candidates.find(entry => entry.source === source)
    if (candidate === undefined) {
      return { imported: [], removed: [], skipped: [{ name: skill.name, reason: 'no-source' }], notes: catalog.notes }
    }
    if (skill.state === 'local') {
      return { imported: [], removed: [], skipped: [{ name: skill.name, reason: 'local-copy' }], notes: catalog.notes }
    }
    const removed: string[] = []
    if (skill.state === 'linked' || skill.state === 'broken') {
      if (request.replace !== true) {
        return { imported: [], removed: [], skipped: [{ name: skill.name, reason: 'already-installed' }], notes: catalog.notes }
      }
      if (skill.installedPath === undefined) {
        return { imported: [], removed: [], skipped: [{ name: skill.name, reason: 'failed' }], notes: catalog.notes }
      }
      try {
        await removeSkillLink(skill.installedPath)
        removed.push(skill.name)
      } catch (error: unknown) {
        const reason = error instanceof SkillLinkError && error.code === 'not-a-link' ? 'not-a-link' : 'failed'
        return { imported: [], removed, skipped: [{ name: skill.name, reason, detail: message(error) }], notes: catalog.notes }
      }
    }
    const result = await install(roots, skill, candidate)
    if (result.skip !== undefined) {
      return { imported: [], removed, skipped: [{ name: skill.name, ...result.skip }], notes: catalog.notes }
    }
    // Asking for a skill again is a decision too, and it outranks the old one.
    const forgotten = await remember(options, skill.name, false)
    return { imported: [skill.name], removed, skipped: [], notes: withNote(catalog.notes, forgotten) }
  })
}

/**
 * Remove one import.
 *
 * Only a link is removed: a real directory in a dsh root belongs to whoever
 * made it, and this is the one operation that could destroy a skill.
 * @param roots - resolved roots in precedence order.
 * @param options - bounds for the scan.
 * @param name - name dsh addresses the skill by.
 * @returns what was removed, and what was left alone.
 */
export async function removeSkill(
  roots: readonly ResolvedSkillRoot[],
  options: SkillImportOptions,
  name: string,
): Promise<SkillImportOutcome> {
  return await exclusive(async () => {
    const catalog = await buildSkillCatalog(roots, options)
    const skill = catalog.skills.find(candidate => candidate.name === name)
    if (skill === undefined || skill.installedPath === undefined) {
      return { imported: [], removed: [], skipped: [{ name, reason: 'no-source' }], notes: catalog.notes }
    }
    if (skill.state === 'local') {
      return { imported: [], removed: [], skipped: [{ name, reason: 'local-copy' }], notes: catalog.notes }
    }
    try {
      await removeSkillLink(skill.installedPath)
    } catch (error: unknown) {
      const reason = error instanceof SkillLinkError && error.code === 'not-a-link' ? 'not-a-link' : 'failed'
      return { imported: [], removed: [], skipped: [{ name, reason, detail: message(error) }], notes: catalog.notes }
    }
    const remembered = await remember(options, name, true)
    return {
      imported: [],
      removed: [name],
      skipped: [],
      notes: options.statePath === undefined
        ? withNote(catalog.notes, remembered)
        : withNote(withNote(catalog.notes, 'automatic import will not bring this name back'), remembered),
    }
  })
}

/** Create the one link an import consists of, reporting why it could not. */
async function install(
  roots: readonly ResolvedSkillRoot[],
  skill: SkillReport,
  candidate: SkillCandidate | undefined,
): Promise<{ readonly skip?: Omit<SkillSkip, 'name'> }> {
  if (candidate === undefined) return { skip: { reason: 'no-source' } }
  const root = roots.find(entry => entry.writable && entry.scope === 'user')
  if (root === undefined) return { skip: { reason: 'failed', detail: 'this profile has no writable user skill directory' } }
  const kind = await readEntryKind(candidate.path)
  if (kind === undefined) return { skip: { reason: 'no-source', detail: `${candidate.path} is gone` } }
  try {
    // Created only when the first import needs it, so a user who never imports
    // keeps a home directory dsh never wrote to.
    await mkdir(root.path, { recursive: true })
    await createSkillLink(candidate.path, join(root.path, skill.name), kind)
    return {}
  } catch (error: unknown) {
    if (error instanceof SkillLinkError && error.code === 'occupied') return { skip: { reason: 'occupied' } }
    if (error instanceof SkillLinkError && error.code === 'unsupported') return { skip: { reason: 'unsupported', detail: error.message } }
    return { skip: { reason: 'failed', detail: message(error) } }
  }
}

/**
 * Where the roots' own dsh home remembers the user's decisions.
 *
 * The writable *user* root, not merely the first writable one: the project-scope
 * dsh root is also writable by the catalog's reckoning and sorts first, and a
 * decision file under it would be written into the user's workspace — and would
 * stop applying the moment another workspace is open. Links land in the same
 * place, for the same reason (see {@link install}).
 * @param roots - resolved roots, one of which is the writable user dsh root.
 * @returns the state file's path, or `undefined` when no user root is writable.
 */
export function skillStatePathFor(roots: readonly ResolvedSkillRoot[]): string | undefined {
  const root = roots.find(entry => entry.writable && entry.scope === 'user')
  return root === undefined ? undefined : skillStatePath(dirname(root.path))
}

/** Names the user removed, which automatic import leaves alone. */
async function readRemoved(options: SkillImportOptions): Promise<ReadonlySet<string>> {
  if (options.statePath === undefined) return new Set()
  return new Set((await readSkillState(options.statePath)).removed)
}

/**
 * Remember one decision, reporting why it could not be remembered.
 *
 * A decision that cannot be written down is worth a line: the operation the
 * user asked for did happen, but the next activation would undo it.
 */
async function remember(options: SkillImportOptions, name: string, removed: boolean): Promise<string | undefined> {
  if (options.statePath === undefined) return undefined
  try {
    const before = await readSkillState(options.statePath)
    await writeSkillState(options.statePath, withDecision(before, name, removed))
    return undefined
  } catch (error: unknown) {
    return `could not remember the decision about "${name}": ${message(error)}`
  }
}

/** Add one optional line to a report. */
function withNote(notes: readonly string[], note: string | undefined): readonly string[] {
  return note === undefined ? [...notes] : [...notes, note]
}

/**
 * Queue one mutation behind every mutation already queued.
 *
 * The queue is module-wide on purpose: two plugin instances, or a request that
 * arrives while the startup synchronization is still running, must not decide
 * and act on the same name concurrently.
 */
let mutations: Promise<unknown> = Promise.resolve()

/** Run one operation after every previously queued one has settled. */
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation, operation)
  mutations = result.then(() => undefined, () => undefined)
  return result
}

/** Describe any thrown value for a report line. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
