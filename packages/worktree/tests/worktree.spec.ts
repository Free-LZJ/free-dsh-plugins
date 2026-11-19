/**
 * The Host half's one piece of real logic: turning a repository directory into a
 * checkout under `.agents/worktrees` without touching the original.
 *
 * These specs run real `git` against a throwaway repository (see
 * `support/git-repository.ts`), plus the two pure guards the route relies on.
 *
 * @module @free-lzj/dsh-worktree/tests/worktree
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, listWorktrees, removeWorktree, worktreeName } from '../src/git.ts'
import { WORKTREE_PARENT } from '../src/protocol.ts'
import { isMutationRequest, isSameOrigin } from '../src/routes.ts'
import { cleanupRepositories, createManaged, git, repository, scratch } from './support/git-repository.ts'

afterEach(cleanupRepositories)

describe('createWorktree', () => {
  it('creates a checkout and branch under the repository, leaving the source alone', async () => {
    const repo = repository()
    const result = await createWorktree(repo, 'feature-a')

    expect(result.branch).toBe('feature-a')
    expect(result.path).toBe(join(repo, '.agents', 'worktrees', 'feature-a'))
    expect(existsSync(join(result.path, 'README.md'))).toBe(true)

    // The parent is ignored exactly once, the way the official runtime does it.
    expect(readFileSync(join(repo, '.agents', 'worktrees', '.gitignore'), 'utf8')).toBe('*\n')

    // The source checkout kept its own file and picked up no worktree contents.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\n')
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain('worktrees/feature-a')
    expect(git(repo, ['branch', '--list', 'feature-a'])).toContain('feature-a')
  })

  it('reports the repository root it branched from', async () => {
    const repo = repository()
    mkdirSync(join(repo, 'nested'))
    const result = await createWorktree(join(repo, 'nested'), 'from-subdir')

    expect(result.repo).toBe(repo)
    expect(result.path).toBe(join(repo, '.agents', 'worktrees', 'from-subdir'))
  })

  it('names an unnamed worktree by its randomness, not by a clock', async () => {
    const repo = repository()
    const first = await createWorktree(repo)
    const second = await createWorktree(repo)

    expect(first.branch).toMatch(/^worktree-[0-9a-f]{8}$/)
    expect(second.branch).not.toBe(first.branch)
  })

  it('refuses a name that is not one clean path segment', async () => {
    const repo = repository()
    expect(() => worktreeName('../escape')).toThrow()
    expect(() => worktreeName('has space')).toThrow()
    await expect(createWorktree(repo, 'a/b')).rejects.toThrow()
  })

  it('refuses a name already taken', async () => {
    const repo = repository()
    await createWorktree(repo, 'taken')
    await expect(createWorktree(repo, 'taken')).rejects.toThrow(/已存在/)
  })

  it('refuses a directory that is not a repository', async () => {
    await expect(createWorktree(scratch(), 'x')).rejects.toThrow()
  })

  it('refuses a relative directory', async () => {
    await expect(createWorktree('.', 'x')).rejects.toThrow(/绝对路径/)
  })

  it('keeps an existing ignore file instead of rewriting it', async () => {
    const repo = repository()
    const parent = join(repo, ...WORKTREE_PARENT.split('/'))
    mkdirSync(parent, { recursive: true })
    writeFileSync(join(parent, '.gitignore'), 'mine\n', 'utf8')

    await createWorktree(repo, 'keep')
    expect(readFileSync(join(parent, '.gitignore'), 'utf8')).toBe('mine\n')
  })
})

describe('route guards', () => {
  /** @param headers - the request headers to present. */
  const request = (headers: Record<string, string>): IncomingMessage => ({ headers } as IncomingMessage)

  it('accepts the page this server sent and refuses another origin', () => {
    expect(isSameOrigin(request({}))).toBe(true)
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isSameOrigin(request({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isSameOrigin(request({ origin: 'https://evil.example' }))).toBe(false)
    expect(isSameOrigin(request({ origin: 'not a url' }))).toBe(false)
  })

  it('needs both the plugin header and a JSON body to mutate', () => {
    expect(isMutationRequest(request({}))).toBe(false)
    expect(isMutationRequest(request({ 'x-dsh-worktrees': '1' }))).toBe(false)
    expect(isMutationRequest(request({ 'x-dsh-worktrees': '1', 'content-type': 'text/plain' }))).toBe(false)
    expect(isMutationRequest(request({ 'x-dsh-worktrees': '1', 'content-type': 'application/json' }))).toBe(true)
  })
})

describe('listWorktrees', () => {
  it('lists the repository checkout first, then its linked checkouts', async () => {
    const repo = repository()
    await createWorktree(repo, 'listed-a')

    const { repo: resolved, worktrees } = await listWorktrees(repo)

    expect(resolved).toBe(repo)
    expect(worktrees).toHaveLength(2)
    const [main, linked] = worktrees
    expect(main).toMatchObject({ path: repo, main: true })
    expect(linked).toMatchObject({
      path: join(repo, '.agents', 'worktrees', 'listed-a'),
      branch: 'listed-a',
      main: false,
      locked: false,
    })
    // The commit the checkout sits on is reported, so the list can show it.
    expect(linked?.head).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('marks a lock Git holds', async () => {
    const repo = repository()
    const created = await createWorktree(repo, 'locked-one')
    git(repo, ['worktree', 'lock', created.path])

    const { worktrees } = await listWorktrees(repo)
    expect(worktrees.find(entry => entry.path === created.path)?.locked).toBe(true)
  })

  // The page has to be able to warn before the press, so the list carries the
  // amount of work each row would lose.
  it('reports how much uncommitted work each linked checkout holds', async () => {
    const repo = repository()
    const clean = createManaged(repo, 'clean-one')
    const dirty = createManaged(repo, 'dirty-one')
    writeFileSync(join(dirty, 'README.md'), 'edited\n', 'utf8')
    writeFileSync(join(dirty, 'added.txt'), 'new\n', 'utf8')

    const { worktrees } = await listWorktrees(repo)

    expect(worktrees.find(entry => entry.path === clean)?.dirty).toBe(0)
    expect(worktrees.find(entry => entry.path === dirty)?.dirty).toBe(2)
    // The repository's own checkout cannot be removed, so it is not inspected.
    expect(worktrees[0]?.dirty).toBeUndefined()
  })
})

describe('removeWorktree', () => {
  it('removes a checkout and the branch that came with it', async () => {
    const repo = repository()
    const created = await createWorktree(repo, 'disposable')

    await removeWorktree(repo, created.path, true)

    expect(existsSync(created.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'disposable']).trim()).toBe('')
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('worktrees/disposable')
  })

  it('refuses the repository checkout itself', async () => {
    const repo = repository()
    await expect(removeWorktree(repo, repo, false)).rejects.toThrow(/主检出/)
  })

  // Checkouts made by the official runtime, by Codex, or by hand sit anywhere
  // on disk; the list has to be able to clear them, not only `.agents/worktrees`.
  it('removes a checkout that lives beside the repository', async () => {
    const repo = repository()
    const outside = join(scratch(), 'beside')
    git(repo, ['worktree', 'add', '-b', 'beside', outside, 'HEAD'])

    await removeWorktree(repo, outside, true)

    expect(existsSync(outside)).toBe(false)
    expect(git(repo, ['branch', '--list', 'beside']).trim()).toBe('')
  })

  it('answers "already gone" for a checkout that no longer exists', async () => {
    const repo = repository()
    // A page loaded before someone deleted the checkout by hand still offers the
    // row; Git has nothing to remove, so the removal is already done.
    const missing = join(repo, '.agents', 'worktrees', 'nope')
    const answer = await removeWorktree(repo, missing, false)
    expect(answer).toMatchObject({ removed: missing, alreadyGone: true })
  })

  it('refuses a directory that exists but is not a checkout of this repository', async () => {
    const repo = repository()
    const outsider = join(repo, '.agents', 'worktrees', 'outsider')
    mkdirSync(outsider, { recursive: true })
    await expect(removeWorktree(repo, outsider, false)).rejects.toThrow(/不是这个仓库/)
    expect(existsSync(outsider)).toBe(true)
  })

  it('keeps an unmerged branch, saying the checkout is already gone', async () => {
    const repo = repository()
    const created = await createWorktree(repo, 'unmerged')
    // One commit on the branch makes it unmerged, so `git branch -d` refuses.
    writeFileSync(join(created.path, 'work.txt'), 'branch work\n', 'utf8')
    git(created.path, ['add', 'work.txt'])
    git(created.path, ['commit', '-m', 'branch work'])

    await expect(removeWorktree(repo, created.path, true)).rejects.toThrow(/分支/)
    expect(existsSync(created.path)).toBe(false)
    expect(git(repo, ['branch', '--list', 'unmerged'])).toContain('unmerged')
  })

  it('refuses a checkout Git holds a lock on', async () => {
    const repo = repository()
    const created = await createWorktree(repo, 'locked-remove')
    git(repo, ['worktree', 'lock', created.path])

    await expect(removeWorktree(repo, created.path, false)).rejects.toThrow(/锁定/)
    expect(existsSync(created.path)).toBe(true)
  })

  // The bug users reported as "nothing happens": the refused removal never
  // reached them, so this pins both the refusal and the fact that forcing is
  // what gets a checkout with local work out of the list.
  it('refuses a checkout that holds uncommitted work and leaves it in place', async () => {
    const repo = repository()
    const created = createManaged(repo, 'dirty-remove')
    writeFileSync(join(created, 'README.md'), 'edited\n', 'utf8')

    await expect(removeWorktree(repo, created, true)).rejects.toThrow(/--force|删除工作树失败/)

    expect(existsSync(created)).toBe(true)
    expect(git(repo, ['branch', '--list', 'dirty-remove'])).toContain('dirty-remove')
  })

  it('removes it anyway when forced, discarding the changes', async () => {
    const repo = repository()
    const created = createManaged(repo, 'dirty-forced')
    writeFileSync(join(created, 'README.md'), 'edited\n', 'utf8')

    await removeWorktree(repo, created, true, true)

    expect(existsSync(created)).toBe(false)
    expect(git(repo, ['branch', '--list', 'dirty-forced']).trim()).toBe('')
  })

  it('forces away a checkout that also sits on an unmerged commit', async () => {
    const repo = repository()
    const created = createManaged(repo, 'both-dirty')
    writeFileSync(join(created, 'work.txt'), 'committed\n', 'utf8')
    git(created, ['add', 'work.txt'])
    git(created, ['commit', '-m', 'work'])
    writeFileSync(join(created, 'README.md'), 'edited\n', 'utf8')

    await removeWorktree(repo, created, true, true)

    expect(existsSync(created)).toBe(false)
    expect(git(repo, ['branch', '--list', 'both-dirty']).trim()).toBe('')
  })
})
