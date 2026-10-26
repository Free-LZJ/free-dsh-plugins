/**
 * Git worktree creation, as the Host half needs it and nothing more.
 *
 * A worktree is one local Git operation plus two pieces of bookkeeping the
 * official worktree runtime establishes: the checkout lives under the
 * repository's own `.agents/worktrees`, and that parent is ignored the first
 * time it is created. Matching that layout on purpose — a checkout made here is
 * the same shape as one made by `create_worktree`, so both can coexist in one
 * repository and the sidebar can nest them under the repository's Workspace.
 *
 * @module @free-lzj/dsh-worktree/git
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WORKTREE_PARENT } from './protocol.ts'

/** A usable branch and directory name: one path segment, no Git-ref punctuation. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Runs one program and buffers its output. */
const run = promisify(execFile)

/** What one successful creation produced. */
export interface CreatedWorktree {
  /** Absolute path of the new checkout. */
  readonly path: string
  /** Branch created for it. */
  readonly branch: string
  /** Top level of the repository it was branched from. */
  readonly repo: string
}

/**
 * Run one Git command, trimming the stream a caller wants.
 *
 * `windowsHide` keeps a console window from flashing on every click; the buffer
 * is large enough for `worktree list` on a repository with many checkouts.
 * @param args - Git arguments, literal (never shell-interpolated).
 * @param cwd - directory Git runs in.
 * @returns stdout, trimmed.
 */
async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * @param path - absolute path to test.
 * @returns whether something already exists there.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * One branch and directory name, sanitized.
 *
 * A blank request is named for its randomness: two people creating a worktree
 * from the same commit in the same minute must not collide on a timestamp.
 * @param requested - the name the user typed, if any.
 * @returns the name to use.
 */
export function worktreeName(requested: string | undefined): string {
  const trimmed = requested?.trim() ?? ''
  if (trimmed === '') return `worktree-${randomBytes(4).toString('hex')}`
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error('名字只能包含字母、数字、点、下划线和短横线，且不能以符号开头')
  }
  return trimmed
}

/**
 * Create one worktree from a directory's repository.
 *
 * `ponytail:` Git runs through `node:child_process` rather than the harness's
 * sandboxed `subprocess` service — the plugin ships without that dependency.
 * The blast radius is one `git` invocation whose arguments are all literal
 * strings this module built; revisit only if a profile needs worktrees created
 * under a narrower filesystem policy than its own Host process runs with.
 * @param dir - directory inside the repository to branch from.
 * @param requested - requested name; omitted means generate one.
 * @returns the created checkout.
 */
export async function createWorktree(dir: string, requested?: string): Promise<CreatedWorktree> {
  if (!isAbsolute(dir)) throw new Error('当前会话的工作目录不是绝对路径')
  let info
  try {
    info = await stat(dir)
  } catch {
    throw new Error(`工作目录不存在：${dir}`)
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹：${dir}`)

  const repo = resolve(await git(['rev-parse', '--show-toplevel'], dir))
  const name = worktreeName(requested)
  const parent = join(repo, ...WORKTREE_PARENT.split('/'))
  const path = join(parent, name)
  if (await exists(path)) throw new Error(`该工作树已存在：${path}`)

  // The ignore file is written only when this module created the parent, so a
  // repository that already ignores or commits `.agents/worktrees` keeps its
  // own rules. `*` is what the official runtime writes.
  const freshParent = !(await exists(parent))
  await mkdir(parent, { recursive: true })
  if (freshParent) await writeFile(join(parent, '.gitignore'), '*\n', 'utf8')

  try {
    await git(['worktree', 'add', '-b', name, path, 'HEAD'], repo)
  } catch (error: unknown) {
    throw new Error(gitFailure(error, '创建失败'))
  }
  return { path, branch: name, repo }
}

/**
 * One word for a Git failure: its first stderr line, which is the sentence Git
 * itself wrote about this repository.
 * @param error - whatever `execFile` rejected with.
 * @param fallback - prefix when Git said nothing.
 * @returns the message a caller may show.
 */
function gitFailure(error: unknown, fallback: string): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim().split('\n')[0] : undefined
  return detail ?? `${fallback}：${error instanceof Error ? error.message : String(error)}`
}

/** One checkout registered with a repository. */
export interface WorktreeEntry {
  /** Absolute path of the checkout. */
  readonly path: string
  /** Branch name, absent for a detached checkout. */
  readonly branch?: string
  /** Commit the checkout is at. */
  readonly head: string
  /** Whether this is the repository's own checkout, which cannot be removed. */
  readonly main: boolean
  /** Git has this checkout locked, so removal would need a force. */
  readonly locked: boolean
  /** Whether the checkout sits under the repository's own `.agents/worktrees`. */
  readonly managed: boolean
}

/**
 * Resolve a directory to its repository's top level.
 * @param dir - any directory inside the repository.
 * @returns the resolved top level.
 */
async function repositoryRoot(dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new Error('当前会话的工作目录不是绝对路径')
  let info
  try {
    info = await stat(dir)
  } catch {
    throw new Error(`目录不存在：${dir}`)
  }
  if (!info.isDirectory()) throw new Error(`不是文件夹：${dir}`)
  return resolve(await git(['rev-parse', '--show-toplevel'], dir))
}

/**
 * Compare two paths the way Windows does, so `D:\a\b` and `d:/a/b/` agree.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they name the same place.
 */
function samePath(left: string, right: string): boolean {
  const norm = (value: string): string => resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * Whether one checkout lives under the repository's own managed parent.
 * @param repo - repository top level.
 * @param path - checkout path.
 * @returns whether it is inside `<repo>/.agents/worktrees`.
 */
function isManaged(repo: string, path: string): boolean {
  const rest = relative(join(repo, ...WORKTREE_PARENT.split('/')), path)
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest)
}

/**
 * Every checkout registered with a directory's repository.
 * @param dir - any directory inside the repository.
 * @returns the repository top level and its checkouts, main checkout first.
 */
export async function listWorktrees(dir: string): Promise<{ repo: string; worktrees: WorktreeEntry[] }> {
  const repo = await repositoryRoot(dir)
  const text = await git(['worktree', 'list', '--porcelain'], repo)
  const worktrees: WorktreeEntry[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line !== '')
    if (lines.length === 0) continue
    let path = ''
    let head = ''
    let branch: string | undefined
    let locked = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = resolve(line.slice('worktree '.length))
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'locked' || line.startsWith('locked ')) locked = true
    }
    if (path === '') continue
    worktrees.push({
      path,
      ...branch === undefined ? {} : { branch },
      head,
      // Git prints the main checkout first, and only it can be a path that is
      // not under the managed parent while still being this repository's.
      main: worktrees.length === 0,
      locked,
      managed: isManaged(repo, path),
    })
  }
  return { repo, worktrees }
}

/**
 * Remove one managed checkout, and its branch when asked and safe.
 *
 * Only checkouts under `<repo>/.agents/worktrees` are removable: that boundary
 * is what keeps a stray call from deleting a checkout someone else made next to
 * the repository. The branch is dropped with `-d`, so Git refuses an unmerged
 * one instead of losing commits.
 * `ponytail:` no `--force` — a checkout with local changes or a lock refuses and
 * says why; add an explicit force toggle when someone actually needs it.
 * @param dir - any directory inside the repository.
 * @param target - checkout to remove.
 * @param deleteBranch - whether to drop its branch as well.
 * @returns what was removed.
 */
export async function removeWorktree(
  dir: string,
  target: string,
  deleteBranch: boolean,
): Promise<{ removed: string; branch?: string }> {
  const repo = await repositoryRoot(dir)
  const { worktrees } = await listWorktrees(repo)
  const entry = worktrees.find(candidate => samePath(candidate.path, target))
  if (entry === undefined) throw new Error(`不是这个仓库的工作树：${target}`)
  if (entry.main) throw new Error('不能删除仓库自己的主检出')
  if (!entry.managed) throw new Error(`只删除 ${WORKTREE_PARENT} 下的工作树：${entry.path}`)
  if (entry.locked) throw new Error(`该工作树被 Git 锁定：${entry.path}`)

  try {
    await git(['worktree', 'remove', entry.path], repo)
  } catch (error: unknown) {
    throw new Error(gitFailure(error, '删除工作树失败'))
  }
  if (deleteBranch && entry.branch !== undefined) {
    try {
      await git(['branch', '-d', entry.branch], repo)
    } catch (error: unknown) {
      // The checkout is gone either way; report the branch refusal as guidance.
      throw new Error(`工作树已删除，但分支 ${entry.branch} 未删除（未合并）：${gitFailure(error, '')}`)
    }
  }
  return { removed: entry.path, ...entry.branch === undefined ? {} : { branch: entry.branch } }
}

