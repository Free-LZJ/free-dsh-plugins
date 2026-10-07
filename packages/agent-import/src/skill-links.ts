/**
 * Link mechanics for importing another agent's skill into dsh's own root.
 *
 * An import is a link, never a copy: the agent that owns the skill keeps being
 * the one place its files live, so an edit there is immediately the edit dsh
 * reads, and removing an import removes nothing but the link. dsh's own
 * filesystem provider resolves a linked directory through `stat()` and reads
 * its `SKILL.md`, so a link is as good as a copy to the catalog while costing
 * no disk and staying in step.
 *
 * The platform decides the form. A directory is linked with a Windows junction
 * where one exists, which needs neither Administrator nor Developer Mode; a
 * plain symbolic link is used everywhere else. A single file — a flat
 * `<name>.md` skill — cannot be a junction, so it needs a file symbolic link,
 * which Windows withholds unless Developer Mode is on; that case is reported as
 * unsupported rather than worked around, because a hard link or a copy would be
 * a file this package cannot tell apart from one the user put there, and so
 * could not be removed without risking real files.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-links
 */

import { lstat, readlink, rmdir, stat, symlink, unlink } from 'node:fs/promises'

/** What a skill root entry is, resolved through any link it may be. */
export type SkillEntryKind = 'directory' | 'file'

/** Why a link operation could not be completed, in terms a caller can report. */
export type SkillLinkProblem = 'occupied' | 'unsupported' | 'not-a-link' | 'io'

/** A link operation that did not happen, carrying a code the caller reports. */
export class SkillLinkError extends Error {
  /** Machine-readable reason. */
  readonly code: SkillLinkProblem

  /**
   * @param code - which failure this is.
   * @param message - human-readable detail, shown in logs and on the page.
   */
  constructor(code: SkillLinkProblem, message: string) {
    super(message)
    this.name = 'SkillLinkError'
    this.code = code
  }
}

/**
 * Report what a root entry is, following any link it may be.
 * @param path - absolute path of the entry.
 * @returns the resolved kind, or undefined when nothing is there.
 */
export async function readEntryKind(path: string): Promise<SkillEntryKind | undefined> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return undefined
  } catch {
    // Absent, broken, or unreadable: every one of them means "no skill here".
    return undefined
  }
}

/**
 * Read where a link points.
 * @param path - absolute path of the entry.
 * @returns the absolute target, or undefined when the entry is not a link.
 */
export async function readLinkTarget(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined
    return normalizeTarget(await readlink(path))
  } catch {
    return undefined
  }
}

/**
 * Create the link that imports one skill.
 * @param target - absolute path of the skill's own directory or file.
 * @param linkPath - absolute path the link is created at, which must not exist.
 * @param kind - whether the imported skill is a directory bundle or a flat file.
 * @throws SkillLinkError with `occupied` when something is already there, `unsupported` when this platform cannot link that kind, `io` for anything else.
 */
export async function createSkillLink(target: string, linkPath: string, kind: SkillEntryKind): Promise<void> {
  if (kind === 'directory') {
    await createDirectoryLink(target, linkPath)
    return
  }
  await createFileLink(target, linkPath)
}

/**
 * Remove one link.
 *
 * Only a link is ever removed: a real directory or file sitting at this path
 * belongs to whoever put it there, and this is the one operation that could
 * destroy a skill, so it refuses instead.
 * @param linkPath - absolute path of the link.
 * @throws SkillLinkError with `not-a-link` when the path is not a link, `io` for anything else.
 */
export async function removeSkillLink(linkPath: string): Promise<void> {
  let info
  try {
    info = await lstat(linkPath)
  } catch (error: unknown) {
    throw new SkillLinkError('io', `cannot read ${linkPath}: ${errorMessage(error)}`)
  }
  if (!info.isSymbolicLink()) {
    throw new SkillLinkError('not-a-link', `${linkPath} is not a link, so removing it could delete real files`)
  }
  try {
    await unlink(linkPath)
  } catch (error: unknown) {
    // A Windows junction is a directory reparse point: unlink normally removes
    // it, and rmdir does when it does not. Neither is recursive, so a target
    // can never be walked into from here.
    if (!isUnlinkFallbackCode(error)) throw new SkillLinkError('io', `cannot remove ${linkPath}: ${errorMessage(error)}`)
    try {
      await rmdir(linkPath)
    } catch (fallback: unknown) {
      throw new SkillLinkError('io', `cannot remove ${linkPath}: ${errorMessage(fallback)}`)
    }
  }
}

/** Link a directory with the form this platform makes cheapest. */
async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error: unknown) {
    throw toLinkError(error, linkPath, 'directory')
  }
}

/** Link a single file, which this platform must permit outright. */
async function createFileLink(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, 'file')
  } catch (error: unknown) {
    throw toLinkError(error, linkPath, 'file')
  }
}

/** Translate a filesystem failure into the code a caller reports. */
function toLinkError(error: unknown, linkPath: string, kind: SkillEntryKind): SkillLinkError {
  const code = errorCode(error)
  if (code === 'EEXIST') return new SkillLinkError('occupied', `${linkPath} already exists`)
  if (kind === 'file' && (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES')) {
    return new SkillLinkError('unsupported', `this platform withholds file links, so ${linkPath} cannot be imported without copying it`)
  }
  return new SkillLinkError('io', `cannot link ${linkPath}: ${errorMessage(error)}`)
}

/** Whether removing a link should be retried as a directory removal. */
function isUnlinkFallbackCode(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EPERM' || code === 'EACCES' || code === 'EISDIR' || code === 'ENOTDIR'
}

/** Strip the prefixes Windows puts in front of a junction target. */
function normalizeTarget(target: string): string {
  return target.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '')
}

/** Read a Node error code without narrowing the error to a class. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Describe any thrown value for a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
