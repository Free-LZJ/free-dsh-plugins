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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
  /** What the branch starts at: an upstream ref, or `HEAD`. */
  readonly base: string
  /** A fetch or upstream problem that did not stop the creation. */
  readonly warning?: string
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

/** How one creation should behave, from the plugin settings. */
export interface CreateOptions {
  /** Absolute directory holding every checkout; empty means the default inside the repository. */
  readonly parent?: string
  /** Fetch upstream refs and branch from them instead of local `HEAD`. */
  readonly fetch?: boolean
}

/**
 * Where a repository's checkouts live.
 *
 * The default keeps them inside the repository (the official layout, already
 * ignored). A configured directory keeps them outside, one subdirectory per
 * repository, so the same branch name in two repositories cannot collide.
 * @param repo - repository top level.
 * @param configured - the settings value, if any.
 * @returns absolute parent directory for this repository's checkouts.
 */
function managedParent(repo: string, configured?: string): string {
  return configured === undefined || configured === ''
    ? join(repo, ...WORKTREE_PARENT.split('/'))
    : join(configured, basename(repo))
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
 * @param options - checkout location and whether to start from upstream.
 * @returns the created checkout and any non-fatal warning.
 */
export async function createWorktree(
  dir: string,
  requested?: string,
  options: CreateOptions = {},
): Promise<CreatedWorktree> {
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
  const parent = managedParent(repo, options.parent)
  const path = join(parent, name)
  if (await exists(path)) throw new Error(`该工作树已存在：${path}`)

  let warning: string | undefined
  let base = 'HEAD'
  if (options.fetch === true) {
    try {
      await git(['fetch', '--all', '--prune'], repo)
    } catch (error: unknown) {
      // Offline or no remote: still usable, just not up to date.
      warning = `拉取上游失败，已从本地 HEAD 创建：${gitFailure(error, 'fetch')}`
    }
    const upstream = await upstreamRef(repo)
    if (upstream !== undefined) base = upstream
  }

  // The ignore file is written only when this module created the parent inside
  // the repository: outside it there is nothing to ignore, and a repository that
  // already ignores or commits `.agents/worktrees` keeps its own rules.
  const insideRepository = parent.startsWith(repo)
  const freshParent = !(await exists(parent))
  await mkdir(parent, { recursive: true })
  if (insideRepository && freshParent) await writeFile(join(parent, '.gitignore'), '*\n', 'utf8')

  try {
    await git(['worktree', 'add', '-b', name, path, base], repo)
  } catch (error: unknown) {
    throw new Error(gitFailure(error, '创建失败'))
  }
  return { path, branch: name, repo, base, ...warning === undefined ? {} : { warning } }
}

/**
 * The current branch's upstream, when it has one.
 * @param repo - repository top level.
 * @returns the upstream ref (e.g. `origin/develop`), or undefined.
 */
async function upstreamRef(repo: string): Promise<string | undefined> {
  try {
    const ref = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repo)
    return ref === '' ? undefined : ref
  } catch {
    return undefined
  }
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
  /** Entries `git status` reports; `0` is clean, absent when unmeasurable. */
  readonly dirty?: number
}

/**
 * Resolve a directory to its repository's top level.
 *
 * A filesystem root is refused even when Git reports it as a repository: a stray
 * `.git` at `C:\` makes `rev-parse` answer `C:/` for every unrelated directory
 * below it, and "this drive is my repository" is never what the caller meant.
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
  const root = resolve(await git(['rev-parse', '--show-toplevel'], dir))
  if (dirname(root) === root) throw new Error(`不在 Git 仓库内：${dir}`)
  return root
}

/**
 * The main checkout of the repository a directory belongs to.
 *
 * A linked checkout reports itself as `--show-toplevel`, so every checkout of one
 * repository would otherwise become its own section. The shared Git directory
 * (`<main>/.git`) names the repository that owns all of them.
 * @param dir - any directory inside the repository, linked checkout included.
 * @returns the main checkout's top level.
 */
export async function primaryRoot(dir: string): Promise<string> {
  const repo = await repositoryRoot(dir)
  let common: string
  try {
    common = await git(['rev-parse', '--git-common-dir'], repo)
  } catch {
    return repo
  }
  const absolute = resolve(repo, common)
  const parent = dirname(absolute)
  return parent === absolute ? repo : parent
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
 * How many entries `git status` reports for one checkout.
 *
 * Reading it here, once per linked checkout, is what lets the page warn before a
 * removal rather than after Git refused it. A checkout that cannot be read is
 * reported as `undefined` instead of `0`: "unknown" and "clean" are different
 * sentences to show a user about to delete work.
 * @param path - the checkout to inspect.
 * @returns the entry count, or undefined when Git would not answer.
 */
async function dirtyCount(path: string): Promise<number | undefined> {
  try {
    const text = await git(['status', '--porcelain', '--untracked-files=normal'], path)
    return text === '' ? 0 : text.split(/\r?\n/).filter(line => line !== '').length
  } catch {
    return undefined
  }
}

/**
 * Every checkout registered with a directory's repository.
 * @param dir - any directory inside the repository.
 * @returns the repository top level and its checkouts, main checkout first.
 */
export async function listWorktrees(
  dir: string,
): Promise<{ repo: string; worktrees: WorktreeEntry[] }> {
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
      // Git prints the main checkout first; every later block is a linked
      // checkout of this repository.
      main: worktrees.length === 0,
      locked,
    })
  }
  // Every linked checkout is measured at the same time: the page shows the whole
  // list at once, so one slow checkout must not delay the rows behind it. The
  // repository's own checkout is never removable and is not measured.
  const measured = await Promise.all(worktrees.map(async (entry) => {
    if (entry.main) return entry
    const dirty = await dirtyCount(entry.path)
    return dirty === undefined ? entry : { ...entry, dirty }
  }))
  return { repo, worktrees: measured }
}

/**
 * Remove one checkout Git has registered with this repository, and its branch
 * when asked and safe.
 *
 * Every registered checkout is removable, not only one this plugin created
 * under `.agents/worktrees`: a checkout made by the official runtime, by Codex,
 * or by hand is the same Git object, and refusing it left the user with a row
 * that only offered "enter". The guards that remain are the ones Git itself
 * cannot be talked out of — the repository's own checkout, and a lock.
 * Without `force`, Git refuses a checkout that holds uncommitted work and the
 * branch is dropped with `-d`, so an unmerged branch survives too: the safe call
 * is the default one. `force` exists for the case that actually blocked users —
 * a checkout with edits they had already given up on — and it discards those
 * edits (`--force`) and any unmerged commits (`-D`). The page asks once, naming
 * what will be lost, before it sends that flag.
 * @param dir - any directory inside the repository.
 * @param target - checkout to remove.
 * @param deleteBranch - whether to drop its branch as well.
 * @param force - discard uncommitted changes and unmerged branch commits.
 * @returns what was removed.
 */
export async function removeWorktree(
  dir: string,
  target: string,
  deleteBranch: boolean,
  force = false,
): Promise<{ removed: string; branch?: string; alreadyGone?: boolean }> {
  const repo = await repositoryRoot(dir)
  const { worktrees } = await listWorktrees(repo)
  const entry = worktrees.find(candidate => samePath(candidate.path, target))
  if (entry === undefined) {
    // The page may predate someone removing this checkout outside the plugin (a
    // hand deletion, another session). Git no longer lists it, so a guard here
    // would leave a row that can never be dismissed; when nothing is left on
    // disk the honest answer is that the removal already happened. A path that
    // still holds files is a different case — the user may have picked the
    // wrong repository — and keeps the guard.
    const gone = await stat(target).then(() => false).catch(() => true)
    if (gone) return { removed: target, alreadyGone: true }
    throw new Error(`不是这个仓库的工作树：${target}`)
  }
  if (entry.main) throw new Error('不能删除仓库自己的主检出')
  if (entry.locked) throw new Error(`该工作树被 Git 锁定：${entry.path}`)

  try {
    await git(['worktree', 'remove', ...force ? ['--force'] : [], entry.path], repo)
  } catch (error: unknown) {
    throw new Error(gitFailure(error, '删除工作树失败'))
  }
  if (deleteBranch && entry.branch !== undefined) {
    try {
      await git(['branch', force ? '-D' : '-d', entry.branch], repo)
    } catch (error: unknown) {
      // The checkout is gone either way; report the branch refusal as guidance.
      throw new Error(`工作树已删除，但分支 ${entry.branch} 未删除（未合并）：${gitFailure(error, '')}`)
    }
  }
  return { removed: entry.path, ...entry.branch === undefined ? {} : { branch: entry.branch } }
}

