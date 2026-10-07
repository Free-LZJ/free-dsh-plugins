import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMPTY_SKILL_STATE,
  readSkillState,
  skillStatePath,
  withDecision,
  writeSkillState,
} from '../src/skill-state.ts'

/** Every temp home created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp home and the state file path inside it. */
async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-import-state-'))
  tempDirs.push(dir)
  return skillStatePath(dir)
}

/** Write raw content to the state file, creating the plugin's own directory. */
async function writeRaw(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('skillStatePath', () => {
  it('keeps the plugin’s own file beside dsh’s skill directory', () => {
    expect(skillStatePath(join('home', '.dsh'))).toBe(join('home', '.dsh', 'agent-import', 'state.json'))
  })
})

describe('readSkillState', () => {
  it('answers the empty state before anything was decided', async () => {
    await expect(readSkillState(await tempStatePath())).resolves.toEqual(EMPTY_SKILL_STATE)
  })

  it('reads back the names it wrote, in order', async () => {
    const path = await tempStatePath()
    await writeSkillState(path, { removed: ['beta', 'alpha'] })
    await expect(readSkillState(path)).resolves.toEqual({ removed: ['beta', 'alpha'] })
  })

  it('answers the empty state for anything it cannot vouch for', async () => {
    const path = await tempStatePath()
    for (const content of ['not json', '[]', 'null', '{"removed":"alpha"}', '{"removed":null}', '{}']) {
      await writeRaw(path, content)
      await expect(readSkillState(path)).resolves.toEqual(EMPTY_SKILL_STATE)
    }
  })

  it('drops entries that are not names, and keeps the ones that are', async () => {
    const path = await tempStatePath()
    await writeRaw(path, JSON.stringify({ removed: ['alpha', 7, null, { name: 'beta' }, 'gamma'] }))
    await expect(readSkillState(path)).resolves.toEqual({ removed: ['alpha', 'gamma'] })
  })
})

describe('withDecision', () => {
  it('adds a removal, keeps names unique and ordered, and withdraws it again', () => {
    const once = withDecision({ removed: ['beta'] }, 'alpha', true)
    expect(once).toEqual({ removed: ['alpha', 'beta'] })
    expect(withDecision(once, 'alpha', true)).toEqual({ removed: ['alpha', 'beta'] })
    expect(withDecision(once, 'beta', false)).toEqual({ removed: ['alpha'] })
    expect(withDecision(EMPTY_SKILL_STATE, 'alpha', false)).toEqual(EMPTY_SKILL_STATE)
  })
})

describe('writeSkillState', () => {
  it('creates the directory it needs and leaves no half-written file behind', async () => {
    const path = await tempStatePath()
    await writeSkillState(path, { removed: ['alpha'] })
    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify({ removed: ['alpha'] }, null, 2)}\n`)
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('replaces the previous decisions rather than appending to them', async () => {
    const path = await tempStatePath()
    await writeSkillState(path, { removed: ['alpha'] })
    await writeSkillState(path, withDecision(await readSkillState(path), 'alpha', false))
    await expect(readSkillState(path)).resolves.toEqual(EMPTY_SKILL_STATE)
  })
})
