import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillLink, readEntryKind, readLinkTarget, removeSkillLink, SkillLinkError } from '../src/skill-links.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp directory. */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-link-')))
  tempDirs.push(dir)
  return dir
}

/** Create one skill bundle and return its directory. */
async function skillBundle(root: string, name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}.\n---\n\nBody.\n`)
  return dir
}

/** Compare two paths the way the platform does. */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Run an operation and return the SkillLinkError it threw. */
async function linkError(operation: () => Promise<unknown>): Promise<SkillLinkError> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof SkillLinkError) return error
    throw error
  }
  throw new Error('expected the operation to fail')
}

describe('createSkillLink', () => {
  it('links a skill directory so it reads as a directory of its own', async () => {
    const root = await tempDir()
    const target = await skillBundle(root, 'alpha')
    const link = join(root, 'linked-alpha')
    await createSkillLink(target, link, 'directory')
    expect(await readEntryKind(link)).toBe('directory')
    expect(samePath((await readLinkTarget(link)) ?? '', target)).toBe(true)
    await expect(readFile(join(link, 'SKILL.md'), 'utf8')).resolves.toContain('name: alpha')
  })

  it('resolves a link whose target is itself a link', async () => {
    const root = await tempDir()
    const target = await skillBundle(root, 'chained')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await createSkillLink(target, first, 'directory')
    await createSkillLink(first, second, 'directory')
    expect(await readEntryKind(second)).toBe('directory')
    await expect(readFile(join(second, 'SKILL.md'), 'utf8')).resolves.toContain('name: chained')
  })

  it('refuses to link over something that is already there', async () => {
    const root = await tempDir()
    const target = await skillBundle(root, 'alpha')
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    const error = await linkError(() => createSkillLink(target, occupied, 'directory'))
    expect(error.code).toBe('occupied')
    expect(await readEntryKind(occupied)).toBe('directory')
    expect(await readLinkTarget(occupied)).toBeUndefined()
  })

  it('links a flat skill file where the platform permits file links', async () => {
    const root = await tempDir()
    const target = join(root, 'flat.md')
    await writeFile(target, '---\nname: flat\ndescription: Flat.\n---\n\nBody.\n')
    const link = join(root, 'linked-flat.md')
    try {
      await createSkillLink(target, link, 'file')
    } catch (error: unknown) {
      // Windows without Developer Mode withholds file links; the import reports
      // that instead of falling back to a copy this package could not remove.
      expect(error).toBeInstanceOf(SkillLinkError)
      expect((error as SkillLinkError).code).toBe('unsupported')
      return
    }
    expect(await readEntryKind(link)).toBe('file')
    await expect(readFile(link, 'utf8')).resolves.toContain('name: flat')
    await removeSkillLink(link)
    expect(await readEntryKind(link)).toBeUndefined()
  })
})

describe('removeSkillLink', () => {
  it('removes the link and leaves the skill it points at untouched', async () => {
    const root = await tempDir()
    const target = await skillBundle(root, 'alpha')
    const link = join(root, 'linked-alpha')
    await createSkillLink(target, link, 'directory')
    await removeSkillLink(link)
    expect(await readEntryKind(link)).toBeUndefined()
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).resolves.toContain('name: alpha')
  })

  it('refuses a real directory, because removing it could delete real files', async () => {
    const root = await tempDir()
    const target = await skillBundle(root, 'alpha')
    const error = await linkError(() => removeSkillLink(target))
    expect(error.code).toBe('not-a-link')
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).resolves.toContain('name: alpha')
  })

  it('reports a path that is simply absent as an io failure', async () => {
    const root = await tempDir()
    const error = await linkError(() => removeSkillLink(join(root, 'missing')))
    expect(error.code).toBe('io')
  })

  it('removes a link whose target is gone', async () => {
    const root = await tempDir()
    const link = join(root, 'dangling')
    await createSkillLink(join(root, 'never-existed'), link, 'directory')
    expect(await readEntryKind(link)).toBeUndefined()
    expect(await readLinkTarget(link)).toBeDefined()
    await removeSkillLink(link)
    expect(await readLinkTarget(link)).toBeUndefined()
  })
})
