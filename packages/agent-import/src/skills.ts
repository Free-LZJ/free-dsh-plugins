/**
 * Skill provider that republishes the skills another agent tool already serves.
 *
 * The provider reads each configured root once per catalog collection, so a
 * skill a user adds for Codex or Claude Code becomes addressable in dsh without
 * a copy step. Candidate construction follows `dsh-skill-filesystem`: bodies are
 * re-read on every {@link ForeignSkillProvider.get}, and a file that disappeared
 * or lost its frontmatter yields `undefined` instead of a stale body. A skill
 * directory a foreign tool reaches through a symbolic link counts as a skill,
 * because sharing one installed copy across tools is the usual arrangement.
 *
 * @module @deepseek-ai/dsh-agent-import/skills
 */

import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillSource, SkillSummary } from '@deepseek-ai/dsh-skill'
import { readSkillFile } from './skill-file.ts'
import type { ParsedSkill } from './skill-file.ts'
import type { ForeignSkillRoot } from './types.ts'

/** Provider name every imported skill reports as its owner in `ctx.skills`. */
export const PROVIDER_NAME = 'agent-import'

/**
 * Precedence rank for skills owned by another agent tool.
 *
 * The shipped bands are 100/200 for project roots, 300 for configured directories,
 * 400/500 for dsh user roots, and 600 for package-bundled skills; lower wins. Imported
 * skills sit between the dsh user roots and the bundled band, so a skill the user put in
 * dsh's own directories always wins a name collision, while a package's demonstration
 * skill never hides the user's existing Codex or Claude Code skill.
 */
export const FOREIGN_SKILL_RANK = 550

/** Instruction file name both foreign tools use inside a skill directory. */
const SKILL_FILE = 'SKILL.md'

/** Reason {@link readSkillFile} reports for a directory that simply has no instruction file. */
const MISSING_FILE = 'file no longer exists'

/** Provider-owned candidate handle passed back into {@link ForeignSkillProvider.get}. */
interface SkillLocator {
  /** Absolute path of the instruction file. */
  readonly path: string
  /** Absolute path of the directory holding the instruction file's resources. */
  readonly directory: string
}

/** Republish the skill directories of other agent tools on `ctx.skills`. */
export class ForeignSkillProvider implements SkillProvider {
  /** Registry-unique provider name; every candidate reports it as its provider. */
  readonly name = PROVIDER_NAME

  readonly #ctx: Context
  readonly #roots: readonly ForeignSkillRoot[]
  readonly #maxSkills: number

  /**
   * @param ctx - context whose logger reports the skill files this provider skips.
   * @param roots - skill directories to read, in precedence order.
   * @param maxSkills - maximum candidates one collection may return.
   */
  constructor(ctx: Context, roots: readonly ForeignSkillRoot[], maxSkills: number) {
    this.#ctx = ctx
    this.#roots = roots
    this.#maxSkills = maxSkills
  }

  /**
   * Read every configured root into candidates.
   * @param options - lookup options; `signal` settles discovery early when the caller aborts.
   * @returns the candidates in root and directory-name order.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const root of this.#roots) {
      if (options.signal?.aborted === true || candidates.length >= this.#maxSkills) break
      candidates.push(...await this.#discover(root, this.#maxSkills - candidates.length))
    }
    return candidates
  }

  /**
   * Re-read the winning candidate's instruction file.
   * @param candidate - candidate originally returned by this provider.
   * @param _options - lookup options this provider does not need to re-read the file.
   * @returns the loaded skill, or `undefined` when the file is gone or no longer usable.
   */
  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as SkillLocator
    const parsed = await readSkillFile(locator.path)
    if (typeof parsed === 'string') {
      this.#ctx.logger.warn(`agent-import: skill "${candidate.name}" is no longer loadable: ${parsed}`)
      return undefined
    }
    return { ...this.#summary(parsed, locator, candidate.source), content: parsed.content }
  }

  /** List one root's skill directories into candidates. */
  async #discover(root: ForeignSkillRoot, limit: number): Promise<SkillCandidate[]> {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch (error: unknown) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      if (!missing) this.#ctx.logger.warn(`agent-import: cannot list skill directory "${root.path}": ${String(error)}`)
      return []
    }
    const candidates: SkillCandidate[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (candidates.length >= limit) break
      if (root.skipDotEntries && entry.name.startsWith('.')) continue
      const directory = join(root.path, entry.name)
      if (!await this.#isSkillDirectory(directory, entry)) continue
      const locator: SkillLocator = { path: join(directory, SKILL_FILE), directory }
      const parsed = await readSkillFile(locator.path)
      if (typeof parsed === 'string') {
        // A directory without an instruction file is an ordinary resident of a foreign skill root.
        if (parsed !== MISSING_FILE) {
          this.#ctx.logger.warn(`agent-import: skill file "${locator.path}" ignored: ${parsed}`)
        }
        continue
      }
      candidates.push({ ...this.#summary(parsed, locator, root.source), rank: FOREIGN_SKILL_RANK, locator })
    }
    return candidates
  }

  /**
   * Report whether one root entry is a directory this provider may read an instruction file from.
   *
   * A plain directory answers from the entry alone. A symbolic link — how a link farm shares one
   * installed skill across tools — is followed, so a link to a directory counts while a link to a
   * file, and one whose target is gone, does not.
   */
  async #isSkillDirectory(directory: string, entry: Dirent): Promise<boolean> {
    if (entry.isDirectory()) return true
    if (!entry.isSymbolicLink()) return false
    let target: Stats
    try {
      target = await stat(directory)
    } catch {
      // A link whose target is gone, or one this process may not stat, holds no skill directory.
      return false
    }
    return target.isDirectory()
  }

  /** Project one parsed file onto the metadata dsh candidates and definitions share. */
  #summary(parsed: ParsedSkill, locator: SkillLocator, source: SkillSource): SkillSummary {
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
      invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
      source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
    }
  }
}
