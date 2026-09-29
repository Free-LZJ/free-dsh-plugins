import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkillFile } from '../src/skill-file.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one file under a fresh temp directory and return its path. */
async function file(name: string, contents: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-skill-')))
  tempDirs.push(dir)
  const path = join(dir, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
  return path
}

/** Read one skill file with the given frontmatter and body. */
async function parsed(frontmatter: string, body = 'Do the thing.\n'): Promise<unknown> {
  return await readSkillFile(await file('SKILL.md', `---\n${frontmatter}\n---\n\n${body}`))
}

describe('readSkillFile', () => {
  it('reads name, description, and body', async () => {
    expect(await parsed('name: epaas-deploy\ndescription: Deploy an app to EPAAS.')).toEqual({
      name: 'epaas-deploy',
      description: 'Deploy an app to EPAAS.',
      modelInvocable: true,
      userInvocable: true,
      content: 'Do the thing.',
    })
  })

  it('keeps an optional whenToUse field', async () => {
    expect(await parsed('name: a\ndescription: d\nwhenToUse: After a release.')).toMatchObject({ whenToUse: 'After a release.' })
  })

  it('omits whenToUse when it is empty', async () => {
    expect(await parsed('name: a\ndescription: d\nwhenToUse: "  "')).not.toHaveProperty('whenToUse')
  })

  it('reads the invocation flags in the spellings the foreign tools write', async () => {
    expect(await parsed('name: a\ndescription: d\ndisable-model-invocation: true\nuser-invocable: "off"')).toMatchObject({
      modelInvocable: false,
      userInvocable: false,
    })
  })

  it('accepts the numeric and negative spellings of a flag', async () => {
    expect(await parsed('name: a\ndescription: d\ndisable-model-invocation: 1\nuser-invocable: 0')).toMatchObject({
      modelInvocable: false,
      userInvocable: false,
    })
    expect(await parsed('name: a\ndescription: d\ndisable-model-invocation: "No"\nuser-invocable: yes')).toMatchObject({
      modelInvocable: true,
      userInvocable: true,
    })
  })

  it('treats an explicit null flag as unset', async () => {
    expect(await parsed('name: a\ndescription: d\ndisable-model-invocation: null')).toMatchObject({ modelInvocable: true })
  })

  it('reports a flag that is not a boolean', async () => {
    expect(await parsed('name: a\ndescription: d\ndisable-model-invocation: maybe')).toBe('"disable-model-invocation" must be a boolean')
    expect(await parsed('name: a\ndescription: d\nuser-invocable: 3')).toBe('"user-invocable" must be a boolean')
  })

  it('reads a CRLF file', async () => {
    const path = await file('SKILL.md', '---\r\nname: a\r\ndescription: d\r\n---\r\n\r\nBody.\r\n')
    expect(await readSkillFile(path)).toMatchObject({ name: 'a', content: 'Body.' })
  })

  it('reads a closing delimiter that ends the file', async () => {
    const path = await file('SKILL.md', '---\nname: a\ndescription: d\n---')
    expect(await readSkillFile(path)).toMatchObject({ name: 'a', content: '' })
  })

  it('reports a single-line file with no frontmatter', async () => {
    expect(await readSkillFile(await file('SKILL.md', '---'))).toBe('missing a `---` YAML frontmatter block')
  })

  it('reports a file that does not start with the delimiter', async () => {
    expect(await readSkillFile(await file('SKILL.md', '# Title\n---\nname: a\n---'))).toBe('missing a `---` YAML frontmatter block')
  })

  it('reports frontmatter that never closes', async () => {
    expect(await readSkillFile(await file('SKILL.md', '---\nname: a\ndescription: d'))).toBe('missing a `---` YAML frontmatter block')
  })

  it('reports frontmatter that is not valid YAML', async () => {
    expect(await readSkillFile(await file('SKILL.md', '---\nname: [a\ndescription: d\n---\n'))).toBe('missing a `---` YAML frontmatter block')
  })

  it('reports frontmatter that is not a mapping', async () => {
    expect(await readSkillFile(await file('SKILL.md', '---\n- a\n- b\n---\n'))).toBe('missing a `---` YAML frontmatter block')
  })

  it('reports a missing or non-string name', async () => {
    expect(await parsed('description: d')).toBe('frontmatter requires a non-empty "name"')
    expect(await parsed('name: 1\ndescription: d')).toBe('frontmatter requires a non-empty "name"')
  })

  it('reports a name outside the skill-name grammar', async () => {
    expect(await parsed('name: Bad_Name\ndescription: d')).toBe('invalid skill name "Bad_Name"')
  })

  it('reports a missing description', async () => {
    expect(await parsed('name: a\ndescription: ""')).toBe('frontmatter requires a non-empty "description"')
  })

  it('reports a file that does not exist', async () => {
    const path = await file('SKILL.md', '---\nname: a\ndescription: d\n---\n')
    await rm(path)
    expect(await readSkillFile(path)).toBe('file no longer exists')
  })

  it('reports a path that cannot be read as a file', async () => {
    const path = await file('SKILL.md', '---\nname: a\ndescription: d\n---\n')
    expect(await readSkillFile(join(path, '..'))).toMatch(/^unreadable \(/)
  })
})
