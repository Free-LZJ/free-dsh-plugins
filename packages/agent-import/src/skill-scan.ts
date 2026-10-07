/**
 * Reading what every agent skill root serves, without writing anything.
 *
 * One scan answers both questions the page asks: which skills exist, and what
 * dsh's own roots already hold. A root that is absent, empty, or unreadable is
 * not a failure — an agent that is not installed contributes nothing — so only
 * genuine surprises become notes.
 *
 * A skill is a directory holding `SKILL.md`, or a top-level `<name>.md` that is
 * not `SKILL.md` itself; both are read through any link, so a linked bundle
 * counts exactly like a real one. The name dsh addresses a skill by comes from
 * its frontmatter, never from the directory name.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-scan
 */

import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readEntryKind, readLinkTarget } from './skill-links.ts'
import { readSkillFile } from './skill-file.ts'
import type { ResolvedSkillRoot, SkillScope, SkillSourceId } from './skill-roots.ts'

/** One skill one root serves. */
export interface SkillEntry {
  /** Name from the skill's frontmatter, which is the name dsh addresses it by. */
  readonly name: string
  /** One-line description from frontmatter. */
  readonly description: string
  /** Agent root this entry was read from. */
  readonly source: SkillSourceId
  /** Tool name shown where a client attributes the skill. */
  readonly label: string
  /** Scope of the root this entry was read from. */
  readonly scope: SkillScope
  /** Absolute path of the skill directory, or of the flat file. */
  readonly path: string
  /** Absolute path of the instruction file. */
  readonly file: string
  /** Whether the entry is a link rather than a real directory or file. */
  readonly linked: boolean
  /** The entry with every link resolved; two roots yielding the same value serve the same files. */
  readonly realPath: string
  /** Whether this entry sits in a root this package owns, so it is a skill dsh already has. */
  readonly writable: boolean
  /** Precedence of the root this entry was read from, lower first. */
  readonly rank: number
}

/** One entry dsh's own skill root holds, whether or not it is a usable skill. */
export interface InstalledEntry {
  /** Directory or file name inside the root, which is also the link name. */
  readonly entry: string
  /** Scope of the root holding it. */
  readonly scope: SkillScope
  /** Absolute path of the entry. */
  readonly path: string
  /** Whether this package created it as a link. */
  readonly linked: boolean
  /** Absolute target when it is a link. */
  readonly target?: string
  /** Whether a link's target is gone, so dsh cannot read the skill at all. */
  readonly broken: boolean
  /** Name the skill declares, absent when it could not be read. */
  readonly name?: string
}

/** What one scan found. */
export interface SkillScan {
  /** Every readable skill each root serves. */
  readonly entries: readonly SkillEntry[]
  /** Every entry the writable dsh roots hold. */
  readonly installed: readonly InstalledEntry[]
  /** Roots and files the scan could not use, as human-readable lines. */
  readonly notes: readonly string[]
}

/** Bounds one scan, so a runaway directory cannot stall the page. */
export interface SkillScanOptions {
  /** Most skills to read in total; further entries are reported as a note. */
  readonly maxSkills: number
}

/**
 * Scan every root for the skills it serves.
 * @param roots - resolved roots, in precedence order.
 * @param options - bounds for the scan.
 * @returns the skills found, the entries dsh's own roots hold, and what was skipped.
 */
export async function scanSkillRoots(
  roots: readonly ResolvedSkillRoot[],
  options: SkillScanOptions,
): Promise<SkillScan> {
  const entries: SkillEntry[] = []
  const installed: InstalledEntry[] = []
  const notes: string[] = []
  let truncated = false
  for (const root of roots) {
    if (await readEntryKind(root.path) !== 'directory') continue
    const children = await readRoot(root, notes)
    for (const child of children) {
      if (child.startsWith('.')) continue
      const path = join(root.path, child)
      const target = await readLinkTarget(path)
      const kind = await readEntryKind(path)
      if (kind === undefined) {
        // Only a link we can no longer resolve is worth a line: it is an import
        // the user made that has stopped working, not an absent entry.
        if (root.writable && target !== undefined) {
          installed.push({ entry: child, scope: root.scope, path, linked: true, target, broken: true })
        }
        continue
      }
      const file = kind === 'directory' ? join(path, 'SKILL.md') : isFlatSkill(child) ? path : undefined
      if (file === undefined || await readEntryKind(file) !== 'file') continue
      if (root.writable) {
        installed.push({
          entry: child,
          scope: root.scope,
          path,
          linked: target !== undefined,
          ...target === undefined ? {} : { target },
          broken: false,
        })
      }
      if (entries.length >= options.maxSkills) {
        truncated = true
        continue
      }
      const parsed = await readSkillFile(file)
      if (typeof parsed === 'string') {
        notes.push(`${file} skipped: ${parsed}`)
        continue
      }
      entries.push({
        name: parsed.name,
        description: parsed.description,
        source: root.source,
        label: root.label,
        scope: root.scope,
        path,
        file,
        linked: target !== undefined,
        realPath: await realPathOr(path),
        writable: root.writable,
        rank: root.rank,
      })
    }
  }
  if (truncated) notes.push(`stopped after ${options.maxSkills} skills; raise maxSkills to read the rest`)
  return { entries, installed, notes }
}

/** List one root's children, reporting an unreadable root instead of failing the scan. */
async function readRoot(root: ResolvedSkillRoot, notes: string[]): Promise<readonly string[]> {
  try {
    const dirents = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
    return dirents.map(dirent => dirent.name)
  } catch (error: unknown) {
    notes.push(`${root.path} could not be listed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** Whether a file name is a flat skill file rather than the bundle's own instruction file. */
function isFlatSkill(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') && lower !== 'skill.md'
}

/** Resolve links, falling back to the path itself when the platform refuses. */
async function realPathOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}
