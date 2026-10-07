/**
 * Merging every agent's skills into the single list the settings page shows.
 *
 * A row is one skill *name*, not one directory: dsh addresses a skill by the
 * name its frontmatter declares, so two tools serving `foo` from different
 * files pose one decision — which copy dsh should read — and the page has to
 * present it that way.
 *
 * Precedence picks the winner by root rank, lowest first. Two roots serving the
 * *same* files (a tool that links another tool's directory, which is how most
 * Codex skills are stored) collapse into one candidate rather than counting as
 * a conflict. A conflict is therefore real: two different file sets claiming one
 * name, which is what the page has to warn about.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-catalog
 */

import { scanSkillRoots, type InstalledEntry, type SkillEntry, type SkillScanOptions } from './skill-scan.ts'
import { readSkillState as readSkillDecisions } from './skill-state.ts'
import type { ResolvedSkillRoot, SkillScope, SkillSourceId } from './skill-roots.ts'

/** What dsh's own roots hold for one skill name. */
export type SkillState =
  /** Nothing is installed yet; the row can be imported. */
  | 'available'
  /** A link this package can remove is in place. */
  | 'linked'
  /** A real directory someone put in a dsh root, which this package never replaces or removes. */
  | 'local'
  /** A link whose target is gone, so dsh cannot read the skill at all. */
  | 'broken'
  /** Nothing is installed because the user removed it, and automatic import leaves it that way. */
  | 'disabled'

/** One root offering a skill name. */
export interface SkillCandidate {
  /** Agent root the entry was read from. */
  readonly source: SkillSourceId
  /** Tool name shown where a client attributes the skill. */
  readonly label: string
  /** Scope of the offering root. */
  readonly scope: SkillScope
  /** Absolute path of the skill directory, or of the flat file. */
  readonly path: string
  /** Absolute path of the instruction file this candidate serves. */
  readonly file: string
  /** Absolute path with every link resolved. */
  readonly realPath: string
  /** Whether the offering root's own entry is itself a link. */
  readonly linked: boolean
  /** Whether precedence picks this candidate as the copy to import. */
  readonly winner: boolean
}

/** One skill name, every source offering it, and what dsh currently holds. */
export interface SkillReport {
  /** Name from frontmatter, which is the name dsh addresses the skill by. */
  readonly name: string
  /** One-line description, taken from the winning candidate or the installed skill. */
  readonly description: string
  /** Offerings, the winner first and the rest in precedence order. */
  readonly candidates: readonly SkillCandidate[]
  /** What dsh's own roots hold for this name. */
  readonly state: SkillState
  /** Absolute path of the entry in the dsh root, present unless the state is `available`. */
  readonly installedPath?: string
  /** Absolute path of the installed skill's instruction file, present when it could still be read. */
  readonly installedFile?: string
  /** Where an installed link points, present when it is a link. */
  readonly installedTarget?: string
  /** Which known source an installed link resolves into; absent when it points outside every known root. */
  readonly installedSource?: SkillSourceId
  /** Whether two or more sources serve this name from different files. */
  readonly conflict: boolean
}

/** The page's whole list, plus what the scan could not use. */
export interface SkillCatalog {
  /** Every skill name any root serves or dsh already holds, sorted by name. */
  readonly skills: readonly SkillReport[]
  /** Files and roots the scan skipped, as human-readable lines. */
  readonly notes: readonly string[]
}

/** Bounds one catalog build, and says where its remembered removals are kept. */
export interface SkillCatalogOptions extends SkillScanOptions {
  /**
   * File recording which names the user removed. Absent reports them as
   * `available`, which is right for a caller that keeps no decisions at all.
   */
  readonly statePath?: string
}

/**
 * Build the merged catalog.
 * @param roots - resolved roots in precedence order, writable ones being dsh's own.
 * @param options - bounds for the underlying scan, and where removals are recorded.
 * @returns every skill name, its offerings, its installed state, and the scan's notes.
 */
export async function buildSkillCatalog(
  roots: readonly ResolvedSkillRoot[],
  options: SkillCatalogOptions,
): Promise<SkillCatalog> {
  // A name with no entry in dsh's root is only *available* until a remembered
  // removal says otherwise: without that, a skill the user switched off would
  // read exactly like one that was never imported.
  const removed = options.statePath === undefined
    ? new Set<string>()
    : new Set((await readSkillDecisions(options.statePath)).removed)
  const scan = await scanSkillRoots(roots, options)
  const offered = new Map<string, SkillEntry[]>()
  const described = new Map<string, string>()
  for (const entry of scan.entries) {
    // Roots arrive in precedence order, so the first description recorded for a
    // name is the one the winning copy declares.
    if (!described.has(entry.name)) described.set(entry.name, entry.description)
    if (entry.writable) continue
    const bucket = offered.get(entry.name)
    if (bucket === undefined) offered.set(entry.name, [entry])
    else bucket.push(entry)
  }
  const installed = indexInstalled(scan.installed, scan.entries)
  const readEntryByPath = new Map(scan.entries.map(entry => [entry.path, entry]))
  const names = new Set<string>([...offered.keys(), ...described.keys(), ...installed.keys()])
  const skills: SkillReport[] = []
  for (const name of names) {
    const candidates = rankCandidates(offered.get(name) ?? [])
    const present = installed.get(name)
    const presentEntry = present === undefined ? undefined : readEntryByPath.get(present.path)
    const installedTarget = present?.target
    const installedSource = attributeTarget(installedTarget, candidates, roots)
    skills.push({
      name,
      description: described.get(name) ?? '',
      candidates,
      state: present === undefined
        ? (removed.has(name) ? 'disabled' : 'available')
        : present.broken ? 'broken' : present.linked ? 'linked' : 'local',
      ...present === undefined ? {} : { installedPath: present.path },
      ...presentEntry === undefined ? {} : { installedFile: presentEntry.file },
      ...installedTarget === undefined ? {} : { installedTarget },
      ...installedSource === undefined ? {} : { installedSource },
      conflict: candidates.length > 1,
    })
  }
  return { skills: skills.sort((left, right) => left.name.localeCompare(right.name)), notes: scan.notes }
}

/**
 * Index dsh's own entries by the name dsh addresses them by.
 *
 * A readable entry declares its own name; a broken link cannot be read, so the
 * entry name stands in for it, which is the name this package gave the link
 * when it created one.
 */
function indexInstalled(entries: readonly InstalledEntry[], read: readonly SkillEntry[]): Map<string, InstalledEntry> {
  const declared = new Map(read.map(entry => [entry.path, entry.name]))
  const index = new Map<string, InstalledEntry>()
  for (const entry of entries) {
    const name = declared.get(entry.path) ?? entry.entry
    if (!index.has(name)) index.set(name, entry)
  }
  return index
}

/**
 * Order one name's offerings, collapse copies of the same files, and mark the winner.
 *
 * Sorting before collapsing means the surviving copy is the best-ranked one,
 * and preferring a real directory over a link means the copy dsh reads is the
 * one an importer wrote rather than a link chain another tool made.
 */
function rankCandidates(entries: readonly SkillEntry[]): readonly SkillCandidate[] {
  const ordered = [...entries].sort((left, right) =>
    left.rank - right.rank || Number(left.linked) - Number(right.linked) || left.path.localeCompare(right.path))
  const distinct = new Map<string, SkillEntry>()
  for (const entry of ordered) {
    const key = comparablePath(entry.realPath)
    if (!distinct.has(key)) distinct.set(key, entry)
  }
  return [...distinct.values()].map((entry, index) => ({
    source: entry.source,
    label: entry.label,
    scope: entry.scope,
    path: entry.path,
    file: entry.file,
    realPath: entry.realPath,
    linked: entry.linked,
    winner: index === 0,
  }))
}

/**
 * Name the source an installed link points into.
 *
 * The offering list answers this when the scan read the target — an import this
 * package made, or one the user made from a tool this scan knows. Otherwise the
 * target is placed in whichever known root contains it, so a hand-made link is
 * still attributed to its tool even when that skill was skipped.
 */
function attributeTarget(
  target: string | undefined,
  candidates: readonly SkillCandidate[],
  roots: readonly ResolvedSkillRoot[],
): SkillSourceId | undefined {
  if (target === undefined) return undefined
  const wanted = comparablePath(target)
  const offering = candidates.find(candidate => comparablePath(candidate.path) === wanted)
  if (offering !== undefined) return offering.source
  const containing = roots
    .filter(root => isInside(wanted, comparablePath(root.path)))
    .sort((left, right) => right.path.length - left.path.length)[0]
  return containing?.source
}

/** Compare paths the way the platform does, so a Windows link matches its root. */
function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Whether a path sits directly inside a root rather than being the root itself. */
function isInside(path: string, root: string): boolean {
  const separator = process.platform === 'win32' ? '\\' : '/'
  return path.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)
}
