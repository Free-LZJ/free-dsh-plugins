import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as AgentImport from '../src/index.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { liveConfig } from './live-config.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp directory to stand in for a foreign tool's home. */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-plugin-')))
  tempDirs.push(dir)
  return dir
}

/** Create one skill directory holding an instruction file. */
async function writeSkill(root: string, name: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}.\n---\n\nBody.\n`)
}

/** Create a Codex home without MCP servers. */
async function codexHome(): Promise<string> {
  const home = await tempDir()
  await writeFile(join(home, 'config.toml'), 'model = "gpt"\n')
  return home
}

/**
 * The plain configuration a test passes to the plugin, without the `null` the
 * schema callable also accepts for its defaults.
 */
type ConfigInput = NonNullable<Parameters<typeof AgentImport.Config>[0]>

/**
 * Mount this plugin on a context that provides the skill catalog.
 * @param input - the configuration to activate with.
 * @returns the mounted context.
 */
async function mount(input: ConfigInput): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentImport, input)
  return ctx
}

/**
 * Mount this plugin behind the Loader so a test can edit the configuration of a running entry.
 * @param input - the configuration the entry starts with.
 * @returns the mounted context and the handle for live edits.
 */
async function mountLive(input: ConfigInput) {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const live = await liveConfig(ctx, AgentImport, input)
  return { ctx, live }
}

/** Every candidate the mounted plugin contributes, in catalog order. */
async function imported(ctx: Context): Promise<SkillSummary[]> {
  return (await ctx.skills.list()).filter(candidate => candidate.provider === 'agent-import')
}

/** Names of the imported candidates, in catalog order. */
async function importedNames(ctx: Context): Promise<string[]> {
  return (await imported(ctx)).map(candidate => candidate.name)
}

describe('apply — imported skills', () => {
  it('publishes the Codex skills of the configured home', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'epaas-deploy')
    const ctx = await mount({ sources: ['codex'], codex: { home }, mcp: false })
    expect((await imported(ctx)).map(candidate => [candidate.name, candidate.source]))
      .toEqual([['epaas-deploy', 'codex']])
    expect((await ctx.skills.get('epaas-deploy'))?.content).toBe('Body.')
  })

  it('leaves the Codex system skills out unless the configuration includes them', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills', '.system'), 'bundled')
    const excluded = await mount({ sources: ['codex'], codex: { home }, mcp: false })
    expect(await imported(excluded)).toEqual([])
    const included = await mount({ sources: ['codex'], codex: { home, includeSystemSkills: true }, mcp: false })
    expect(await importedNames(included)).toEqual(['bundled'])
  })

  it('publishes the Claude Code skills of the user and workspace directories', async () => {
    const dir = await tempDir()
    const project = await tempDir()
    await writeSkill(join(dir, 'skills'), 'user-skill')
    await writeSkill(join(project, '.claude', 'skills'), 'project-skill')
    const ctx = await mount({ sources: ['claude-code'], claudeCode: { configDir: dir }, projectRoot: project, mcp: false })
    expect((await importedNames(ctx)).sort()).toEqual(['project-skill', 'user-skill'])
  })

  it('reads the workspace configuration of the process working directory when no project is configured', async () => {
    const project = await tempDir()
    await writeSkill(join(project, '.claude', 'skills'), 'workspace-skill')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)
    try {
      const ctx = await mount({ sources: ['claude-code'], claudeCode: { configDir: await tempDir() }, mcp: false })
      expect(await importedNames(ctx)).toEqual(['workspace-skill'])
    } finally {
      cwd.mockRestore()
    }
  })

  it('keeps the first-declared source as the winner of a shared skill name', async () => {
    const home = await codexHome()
    const dir = await tempDir()
    await writeSkill(join(home, 'skills'), 'shared')
    await writeSkill(join(dir, 'skills'), 'shared')
    const ctx = await mount({ sources: ['codex', 'claude-code'], codex: { home }, claudeCode: { configDir: dir }, mcp: false })
    expect(await importedNames(ctx)).toEqual(['shared'])
    expect(await ctx.skills.get('shared')).toMatchObject({ source: 'codex' })
  })

  it('reads a repeated source once', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'once')
    const ctx = await mount({ sources: ['codex', 'codex'], codex: { home }, mcp: false })
    expect(await imported(ctx)).toHaveLength(1)
  })

  it('reads nothing when the configuration selects no source', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'unused')
    const ctx = await mount({ sources: [], codex: { home }, mcp: false })
    expect(await imported(ctx)).toEqual([])
  })

  it('publishes nothing when skills are switched off', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'ignored')
    const ctx = await mount({ sources: ['codex'], codex: { home }, skills: false, mcp: false })
    expect(await imported(ctx)).toEqual([])
  })

  it('honors the skill cap', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'alpha')
    await writeSkill(join(home, 'skills'), 'beta')
    const ctx = await mount({ sources: ['codex'], codex: { home }, mcp: false, maxSkills: 1 })
    expect(await importedNames(ctx)).toEqual(['alpha'])
  })

  it('reports a skill file it cannot read and keeps the rest of the catalog', async () => {
    const home = await codexHome()
    await mkdir(join(home, 'skills'), { recursive: true })
    await mkdir(join(home, 'skills', 'broken'), { recursive: true })
    await writeFile(join(home, 'skills', 'broken', 'SKILL.md'), 'no frontmatter\n')
    await writeSkill(join(home, 'skills'), 'working')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(AgentImport, { sources: ['codex'], codex: { home }, mcp: false })
    expect(await importedNames(ctx)).toEqual(['working'])
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('broken'))).toBe(true)
  })
})

describe('apply — registration lifecycle', () => {
  it('removes the imported catalog when the plugin fiber is disposed', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'transient')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentImport, { sources: ['codex'], codex: { home }, mcp: false })
    expect(await importedNames(ctx)).toEqual(['transient'])
    await fiber.dispose()
    expect(await imported(ctx)).toEqual([])
    expect(await ctx.skills.get('transient')).toBeUndefined()
  })

  it('refuses a second provider in the same scope instead of hiding one catalog', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'twice')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentImport, { sources: ['codex'], codex: { home }, mcp: false })
    await expect(ctx.plugin(AgentImport, { sources: ['codex'], codex: { home }, mcp: false }))
      .rejects.toThrow(/already registered/)
  })
})

describe('apply — live configuration changes', () => {
  it('replaces the whole published catalog after a live configuration change', async () => {
    const before = await codexHome()
    const after = await codexHome()
    await writeSkill(join(before, 'skills'), 'before')
    await writeSkill(join(after, 'skills'), 'after')
    const { ctx, live } = await mountLive({ sources: ['codex'], codex: { home: before }, mcp: false })
    expect(await importedNames(ctx)).toEqual(['before'])
    await live.update({ codex: { home: after } })
    await vi.waitFor(async () => { expect(await importedNames(ctx)).toEqual(['after']) })
    expect(await ctx.skills.get('before')).toBeUndefined()
  })

  it('withdraws the catalog when a live change switches skills off and publishes it again when switched back on', async () => {
    const home = await codexHome()
    await writeSkill(join(home, 'skills'), 'toggle')
    const { ctx, live } = await mountLive({ sources: ['codex'], codex: { home }, mcp: false })
    expect(await importedNames(ctx)).toEqual(['toggle'])
    await live.update({ skills: false })
    await vi.waitFor(async () => { expect(await imported(ctx)).toEqual([]) })
    await live.update({ skills: true })
    await vi.waitFor(async () => { expect(await importedNames(ctx)).toEqual(['toggle']) })
  })

  it('stops importing from a source removed by a live configuration change', async () => {
    const home = await codexHome()
    const dir = await tempDir()
    await writeSkill(join(home, 'skills'), 'from-codex')
    await writeSkill(join(dir, 'skills'), 'from-claude')
    const { ctx, live } = await mountLive({ sources: ['codex', 'claude-code'], codex: { home }, claudeCode: { configDir: dir }, mcp: false })
    expect((await importedNames(ctx)).sort()).toEqual(['from-claude', 'from-codex'])
    await live.update({ sources: ['claude-code'] })
    await vi.waitFor(async () => { expect(await importedNames(ctx)).toEqual(['from-claude']) })
    expect(await ctx.skills.get('from-codex')).toBeUndefined()
  })
})
