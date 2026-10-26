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
import { isAbsolute, join, resolve } from 'node:path'
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
    const stderr = (error as { stderr?: unknown }).stderr
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim().split('\n')[0] : undefined
    throw new Error(detail ?? `创建失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { path, branch: name, repo }
}
