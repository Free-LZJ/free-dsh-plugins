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
import { cleanupRepositories, git, repository, scratch } from './support/git-repository.ts'

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
  it('lists the repository checkout first, then the managed ones', async () => {
    const repo = repository()
    await createWorktree(repo, 'listed-a')

    const { repo: resolved, worktrees } = await listWorktrees(repo)

    expect(resolved).toBe(repo)
    expect(worktrees).toHaveLength(2)
    const [main, managed] = worktrees
    expect(main).toMatchObject({ path: repo, main: true, managed: false })
    expect(managed).toMatchObject({
      path: join(repo, '.agents', 'worktrees', 'listed-a'),
      branch: 'listed-a',
      main: false,
      managed: true,
      locked: false,
    })
    // The commit the checkout sits on is reported, so the list can show it.
    expect(managed?.head).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('marks a lock Git holds', async () => {
    const repo = repository()
    const created = await createWorktree(repo, 'locked-one')
    git(repo, ['worktree', 'lock', created.path])

    const { worktrees } = await listWorktrees(repo)
    expect(worktrees.find(entry => entry.path === created.path)?.locked).toBe(true)
  })
})

describe('removeWorktree', () => {
  it('removes a managed checkout and the branch that came with it', async () => {
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

  it('refuses a checkout outside the managed parent', async () => {
    const repo = repository()
    const outside = join(scratch(), 'beside')
    git(repo, ['worktree', 'add', '-b', 'beside', outside, 'HEAD'])

    await expect(removeWorktree(repo, outside, false)).rejects.toThrow(/工作树目录/)
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses an unknown path', async () => {
    const repo = repository()
    await expect(removeWorktree(repo, join(repo, '.agents', 'worktrees', 'nope'), false)).rejects.toThrow(/不是这个仓库/)
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
})
