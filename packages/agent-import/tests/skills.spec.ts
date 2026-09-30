import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FOREIGN_SKILL_RANK, ForeignSkillProvider, PROVIDER_NAME } from '../src/skills.ts'
import type { ForeignSkillRoot } from '../src/types.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp directory to serve as a foreign skill root. */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-root-')))
  tempDirs.push(dir)
  return dir
}

/** Create one skill directory holding an instruction file. */
async function writeSkill(root: string, name: string, frontmatter = `name: ${name}\ndescription: Skill ${name}.`, body = `Body of ${name}.`): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
}

/** A context with a spy on the warning channel the provider reports through. */
function context(): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  const warn = vi.fn()
  vi.spyOn(ctx.logger, 'warn').mockImplementation(warn)
  return { ctx, warn }
}

/** Build a provider over the given roots. */
function provider(ctx: Context, roots: ForeignSkillRoot[], maxSkills = 200): ForeignSkillProvider {
  return new ForeignSkillProvider(ctx, roots, maxSkills)
}

/** One root declaration for a Codex-style directory. */
function root(path: string, skipDotEntries = true): ForeignSkillRoot {
  return { path, source: 'codex', skipDotEntries }
}

describe('ForeignSkillProvider.list', () => {
  it('publishes every skill directory as a ranked candidate', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'epaas-deploy', 'name: epaas-deploy\ndescription: Deploy.\nwhenToUse: After a build.\ndisable-model-invocation: true')
    const { ctx } = context()
    const candidates = await provider(ctx, [root(dir)]).list({})
    expect(candidates).toEqual([{
      name: 'epaas-deploy',
      description: 'Deploy.',
      whenToUse: 'After a build.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'codex',
      provider: PROVIDER_NAME,
      rank: FOREIGN_SKILL_RANK,
      locator: { path: join(dir, 'epaas-deploy', 'SKILL.md'), directory: join(dir, 'epaas-deploy') },
      resourceBase: { kind: 'directory', path: join(dir, 'epaas-deploy') },
      path: join(dir, 'epaas-deploy', 'SKILL.md'),
    }])
  })

  it('orders skills by directory name and roots by declaration order', async () => {
    const first = await tempDir()
    const second = await tempDir()
    await writeSkill(first, 'zeta')
    await writeSkill(first, 'alpha')
    await writeSkill(second, 'alpha')
    const { ctx } = context()
    const names = (await provider(ctx, [root(second), root(first)]).list({}))
      .map(candidate => [candidate.name, candidate.source])
    expect(names).toEqual([['alpha', 'codex'], ['alpha', 'codex'], ['zeta', 'codex']])
  })

  it('skips dot entries unless the root keeps them', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, '.hidden'), { recursive: true })
    await writeFile(join(dir, '.hidden', 'SKILL.md'), '---\nname: hidden\ndescription: Dot skill.\n---\n\nBody.\n')
    await writeSkill(dir, 'visible')
    const { ctx } = context()
    expect((await provider(ctx, [root(dir)]).list({})).map(candidate => candidate.name)).toEqual(['visible'])
    expect((await provider(ctx, [root(dir, false)]).list({})).map(candidate => candidate.name)).toEqual(['hidden', 'visible'])
  })

  it('ignores entries that are not directories', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'flat.md'), '---\nname: flat\ndescription: d\n---\n')
    await writeSkill(dir, 'nested')
    const { ctx } = context()
    expect((await provider(ctx, [root(dir)]).list({})).map(candidate => candidate.name)).toEqual(['nested'])
  })

  it('follows a skill directory linked into a root', async () => {
    const store = await tempDir()
    const dir = await tempDir()
    await writeSkill(store, 'drawio-generator')
    const link = join(dir, 'drawio-generator')
    await symlink(join(store, 'drawio-generator'), link, process.platform === 'win32' ? 'junction' : 'dir')
    const { ctx } = context()
    const candidates = await provider(ctx, [root(dir)]).list({})
    expect(candidates.map(candidate => candidate.name)).toEqual(['drawio-generator'])
    expect(candidates[0]?.path).toBe(join(link, 'SKILL.md'))
  })

  it('ignores a directory without an instruction file and reports one that is unusable', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'no-instructions'))
    await mkdir(join(dir, 'broken'))
    await writeFile(join(dir, 'broken', 'SKILL.md'), '---\nname: Bad_Name\ndescription: d\n---\n')
    const { ctx, warn } = context()
    expect(await provider(ctx, [root(dir)]).list({})).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('invalid skill name "Bad_Name"')
  })

  it('ignores a root that does not exist', async () => {
    const dir = await tempDir()
    const { ctx, warn } = context()
    expect(await provider(ctx, [root(join(dir, 'absent'))]).list({})).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a root that cannot be listed', async () => {
    const dir = await tempDir()
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'x')
    const { ctx, warn } = context()
    expect(await provider(ctx, [root(file)]).list({})).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stops at the collection cap', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'alpha')
    await writeSkill(dir, 'beta')
    await writeSkill(dir, 'gamma')
    const { ctx } = context()
    expect((await provider(ctx, [root(dir)], 2).list({})).map(candidate => candidate.name)).toEqual(['alpha', 'beta'])
  })

  it('stops before a later root once the cap is reached', async () => {
    const first = await tempDir()
    const second = await tempDir()
    await writeSkill(first, 'alpha')
    await writeSkill(second, 'beta')
    const { ctx } = context()
    expect((await provider(ctx, [root(first), root(second)], 1).list({})).map(candidate => candidate.name)).toEqual(['alpha'])
  })

  it('stops reading roots when the caller aborts', async () => {
    const first = await tempDir()
    const second = await tempDir()
    await writeSkill(first, 'alpha')
    await writeSkill(second, 'beta')
    const { ctx } = context()
    const controller = new AbortController()
    controller.abort()
    expect((await provider(ctx, [root(first), root(second)]).list({ signal: controller.signal })).map(candidate => candidate.name))
      .toEqual([])
  })
})

describe('ForeignSkillProvider.get', () => {
  it('re-reads the instruction body of the winning candidate', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'alpha', 'name: alpha\ndescription: First.', 'First body.')
    const { ctx } = context()
    const instance = provider(ctx, [root(dir)])
    const candidate = (await instance.list({}))[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    expect(await instance.get(candidate, {})).toEqual({
      name: 'alpha',
      description: 'First.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'codex',
      provider: PROVIDER_NAME,
      resourceBase: { kind: 'directory', path: join(dir, 'alpha') },
      path: join(dir, 'alpha', 'SKILL.md'),
      content: 'First body.',
    })
  })

  it('reflects a body edited after the candidate was listed', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'alpha', undefined, 'First body.')
    const { ctx } = context()
    const instance = provider(ctx, [root(dir)])
    const candidate = (await instance.list({}))[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    await writeSkill(dir, 'alpha', undefined, 'Second body.')
    expect((await instance.get(candidate, {}))?.content).toBe('Second body.')
  })

  it('returns nothing for a candidate whose file disappeared', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'alpha')
    const { ctx, warn } = context()
    const instance = provider(ctx, [root(dir)])
    const candidate = (await instance.list({}))[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    await rm(join(dir, 'alpha'), { recursive: true, force: true })
    expect(await instance.get(candidate, {})).toBeUndefined()
    expect(String(warn.mock.calls[0]?.[0])).toContain('file no longer exists')
  })

  it('returns nothing for a candidate whose instructions became unusable', async () => {
    const dir = await tempDir()
    await writeSkill(dir, 'alpha')
    const { ctx, warn } = context()
    const instance = provider(ctx, [root(dir)])
    const candidate = (await instance.list({}))[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    await writeFile(join(dir, 'alpha', 'SKILL.md'), 'no frontmatter\n')
    expect(await instance.get(candidate, {})).toBeUndefined()
    expect(String(warn.mock.calls[0]?.[0])).toContain('is no longer loadable')
  })
})
