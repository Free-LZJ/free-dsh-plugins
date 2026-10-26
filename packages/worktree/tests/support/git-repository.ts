/**
 * A throwaway Git repository for the Host specs.
 *
 * Real `git` against a real directory: the contract under test is what Git
 * produced, and a mocked `execFile` would only assert that this package called
 * itself.
 *
 * @module @free-lzj/dsh-worktree/tests/support/git-repository
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Directories these helpers created, removed by {@link cleanupRepositories}. */
const created: string[] = []

/**
 * Run one Git command in a directory.
 * @param dir - working directory.
 * @param args - Git arguments.
 * @returns stdout.
 */
export function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' })
}

/**
 * Build a repository with one commit on `main`.
 * @returns its top-level directory.
 */
export function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-worktree-'))
  created.push(dir)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Worktree Test'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
  return dir
}

/**
 * Build an empty scratch directory.
 * @returns its absolute path.
 */
export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-worktree-plain-'))
  created.push(dir)
  return dir
}

/** Remove every directory these helpers created. */
export function cleanupRepositories(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Create one worktree under the repository's managed parent, the way the plugin
 * itself does, and hand back its path.
 * @param repo - repository top level.
 * @param name - branch and directory name.
 * @returns the checkout path.
 */
export function createManaged(repo: string, name: string): string {
  const path = join(repo, '.agents', 'worktrees', name)
  execFileSync('git', ['worktree', 'add', '-b', name, path, 'HEAD'], { cwd: repo, stdio: 'ignore' })
  return path
}
