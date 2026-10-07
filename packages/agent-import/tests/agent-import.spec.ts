/**
 * Activation: importing the enabled skill sources as links in dsh's own root,
 * keeping them in step with later configuration edits, and never writing to the
 * directories they come from.
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as AgentImport from '../src/index.ts'
import { REPORT_PATH } from '../src/report.ts'
import type { AgentImportReport } from '../src/report.ts'
import { createSkillLink, readLinkTarget } from '../src/skill-links.ts'
import type { SkillCatalog } from '../src/skill-catalog.ts'
import { SKILLS_PATH } from '../src/skill-routes.ts'
import { liveConfig } from './live-config.ts'

/** Codex's own bundled-skill directory, which the scan skips unless a root names it. */
const BUNDLED = '.system'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []

/** Values the environment held before this file redirected anything. */
const savedEnv = new Map<string, string | undefined>()

/** The temp home this test already redirected the user home to, if it did. */
let redirectedHome: string | undefined

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  redirectedHome = undefined
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp directory, removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `agent-import-${prefix}-`)))
  tempDirs.push(dir)
  return dir
}

/** Point one environment variable at a directory for this test only. */
function redirect(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

/**
 * Create one skill bundle under a skills root.
 * @param root - the directory holding skill bundles.
 * @param name - skill name, and the bundle's directory name.
 * @param description - description the instruction file declares.
 * @returns the bundle directory a link should point at.
 */
async function writeSkill(root: string, name: string, description = `Skill ${name}.`): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`)
  return dir
}

/**
 * Create one foreign tool home holding the named skills.
 * @param prefix - name this directory carries in the temp path.
 * @param names - skills to create under `<home>/skills`.
 * @returns the home directory.
 */
async function skillHome(prefix: string, names: readonly string[] = []): Promise<string> {
  const home = await tempDir(prefix)
  for (const name of names) await writeSkill(join(home, 'skills'), name)
  return home
}

/**
 * Create a temp dsh home and point `DSH_HOME` at it.
 * @returns the skill root imports land in, `<home>/skills`.
 */
async function dshHome(): Promise<string> {
  const home = await tempDir('dsh')
  redirect('DSH_HOME', home)
  return join(home, 'skills')
}

/**
 * Refuse to activate without a temp dsh home.
 *
 * The plugin imports into `<DSH_HOME>/skills`, so a test that forgot to redirect
 * `DSH_HOME` would write into the developer's own home.
 */
function requireTempDshHome(): void {
  if (process.env['DSH_HOME'] === undefined) {
    throw new Error('point DSH_HOME at a temp directory with dshHome() before activating the plugin')
  }
}

/**
 * The plain configuration a test passes to the plugin, without the `null` the
 * schema callable also accepts for its defaults.
 */
type ConfigInput = NonNullable<Parameters<typeof AgentImport.Config>[0]>

/**
 * Point the user home at a temp directory.
 *
 * Every known source is read, and only two of them have a path option, so the
 * rest default to `<home>/.<tool>`: without this a test would read — and could
 * import — whatever the developer's own agent directories hold. The first call
 * of a test decides the directory, so a test that places a skill under a tool
 * with no path option is writing into the home activation will read.
 * @returns the temp home the sources now resolve under.
 */
async function tempHome(): Promise<string> {
  if (redirectedHome !== undefined) return redirectedHome
  const home = await tempDir('home')
  redirect('HOME', home)
  redirect('USERPROFILE', home)
  redirectedHome = home
  return home
}

/**
 * Activate this plugin on its own context, with a workspace and two empty foreign
 * homes of its own, so no test reads a real home by default.
 * @param input - the configuration to activate with.
 * @returns the plugin fiber, so a test can dispose it.
 */
async function activate(input: ConfigInput): Promise<Fiber> {
  requireTempDshHome()
  await tempHome()
  const ctx = new Context()
  return await ctx.plugin(AgentImport, {
    projectRoot: await tempDir('workspace'),
    // Both sources are enabled by default, so both have to point somewhere empty.
    codex: { home: await skillHome('codex') },
    claudeCode: { configDir: await skillHome('claude') },
    ...input,
  })
}

/**
 * Activate this plugin and return the context it owns.
 * @param input - the configuration to activate with.
 * @returns the context holding the plugin.
 */
async function mount(input: ConfigInput): Promise<Context> {
  return (await activate(input)).ctx
}

/**
 * Activate this plugin behind the Loader so a test can edit the configuration of a running entry.
 * @param input - the configuration the entry starts with.
 * @returns the mounted context and the handle for live edits.
 */
async function mountLive(input: ConfigInput) {
  requireTempDshHome()
  await tempHome()
  const ctx = new Context()
  // The report route is how a test sees one generation replace the one before it.
  await ctx.plugin(RecordingWebServer)
  const live = await liveConfig(ctx, AgentImport, {
    projectRoot: await tempDir('workspace'),
    codex: { home: await skillHome('codex') },
    claudeCode: { configDir: await skillHome('claude') },
    ...input,
  })
  return { ctx, live }
}

/** A webserver stand-in that records the routes a plugin registers. */
class RecordingWebServer extends Service {
  /** Routes registered so far, in registration order. */
  readonly routes: WebRoute[] = []

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /**
   * Record one route.
   * @param route - the registration.
   * @returns the disposer removing it again.
   */
  register(route: WebRoute): () => void {
    this.routes.push(route)
    return () => { void this.routes.splice(this.routes.indexOf(route), 1) }
  }
}

/**
 * Read the report the plugin's route answers right now, to watch one generation
 * replace the one before it.
 * @param ctx - the composition to read.
 * @returns the parsed report.
 */
async function reportNow(ctx: Context): Promise<AgentImportReport> {
  const webServer: unknown = ctx.get('webServer')
  // This file mounts the composition's only webserver, and mounts it as a recorder.
  if (!(webServer instanceof RecordingWebServer)) throw new Error('the composition has no recording webserver')
  const route = webServer.routes.find(candidate => candidate.path === REPORT_PATH)
  if (route === undefined) throw new Error('the plugin registered no report route')
  let status = 0
  let body = ''
  // The route reads only the method and headers, so a stand-in response is
  // enough to read it without a socket.
  const req = { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } } as unknown as IncomingMessage
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  await route.handler(req, res)
  if (status !== 200) throw new Error(`the report route answered ${status}: ${body}`)
  return JSON.parse(body) as AgentImportReport
}

/** The entries dsh's own root holds, sorted; an absent root reads as empty. */
async function linkedNames(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[])
  return [...entries].sort()
}

/**
 * Whether the entry at `path` is a link to the directory `target`.
 * @param path - the entry inside dsh's own root.
 * @param target - the directory the link should point at.
 * @returns true when the entry links to that directory.
 */
async function linksTo(path: string, target: string): Promise<boolean> {
  const found = await readLinkTarget(path)
  if (found === undefined) return false
  const [left, right] = await Promise.all([realpath(found), realpath(target)])
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

describe('apply — importing skills', () => {
  it('links each enabled source skill into dsh’s own root, leaving the sources alone', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const claude = await skillHome('claude', ['beta'])
    const root = await dshHome()

    await mount({ sources: [], codex: { home: codex }, claudeCode: { configDir: claude }, mcp: false })

    expect(await linkedNames(root)).toEqual(['alpha', 'beta'])
    expect(await linksTo(join(root, 'alpha'), join(codex, 'skills', 'alpha'))).toBe(true)
    expect(await linksTo(join(root, 'beta'), join(claude, 'skills', 'beta'))).toBe(true)
    // The owning tool keeps its own directory: nothing was copied into dsh, and
    // no source directory was turned into a link.
    const owned = join(codex, 'skills', 'alpha')
    expect(await readLinkTarget(owned)).toBeUndefined()
    await expect(readFile(join(owned, 'SKILL.md'), 'utf8')).resolves.toContain('Body of alpha.')
  })

  it('imports the skills of a workspace the project root names', async () => {
    const project = await tempDir('project')
    const skill = await writeSkill(join(project, '.claude', 'skills'), 'workspace-skill')
    const root = await dshHome()

    await mount({
      sources: [],
      skillSources: ['claude-code'],
      projectRoot: project,
      claudeCode: { configDir: await skillHome('claude') },
      mcp: false,
    })

    expect(await linkedNames(root)).toEqual(['workspace-skill'])
    expect(await linksTo(join(root, 'workspace-skill'), skill)).toBe(true)
  })

  it('reads skills from the homes the options name, not the environment they override', async () => {
    const codex = await skillHome('codex', ['chosen'])
    const claude = await skillHome('claude', ['claude-chosen'])
    // The environment stands in for the defaults (`~/.codex`, `~/.claude`), which
    // a test must not read, let alone import from.
    redirect('CODEX_HOME', await skillHome('codex-decoy', ['decoy']))
    redirect('CLAUDE_CONFIG_DIR', await skillHome('claude-decoy', ['claude-decoy']))
    const root = await dshHome()

    await mount({ sources: [], codex: { home: codex }, claudeCode: { configDir: claude }, mcp: false })

    expect(await linkedNames(root)).toEqual(['chosen', 'claude-chosen'])
  })

  it('leaves Codex’s bundled skills out by default', async () => {
    const codex = await skillHome('codex', ['alpha'])
    await writeSkill(join(codex, 'skills', BUNDLED), 'bundled')
    const root = await dshHome()

    await mount({ sources: [], codex: { home: codex }, mcp: false })

    expect(await linkedNames(root)).toEqual(['alpha'])
  })

  it('imports Codex’s bundled skills when the option asks for them', async () => {
    const codex = await skillHome('codex', ['alpha'])
    await writeSkill(join(codex, 'skills', BUNDLED), 'bundled')
    const root = await dshHome()

    await mount({ sources: [], codex: { home: codex, includeSystemSkills: true }, mcp: false })

    expect(await linkedNames(root)).toEqual(['alpha', 'bundled'])
  })

  it('imports nothing while the skills setting is off', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const root = await dshHome()

    await mount({ sources: [], skills: false, codex: { home: codex }, mcp: false })

    // Not even the root: a user who never imports keeps a dsh home the plugin
    // never wrote to.
    await expect(readdir(root)).rejects.toThrow()
  })

  it('never replaces a real directory in dsh’s own root', async () => {
    const codex = await skillHome('codex', ['gamma'])
    const root = await dshHome()
    const mine = await writeSkill(root, 'gamma', 'Mine.')

    await mount({ sources: [], codex: { home: codex }, mcp: false })

    expect(await readLinkTarget(mine)).toBeUndefined()
    await expect(readFile(join(mine, 'SKILL.md'), 'utf8')).resolves.toContain('Mine.')
  })

  it('keeps a link someone made by hand instead of re-pointing it at its own candidate', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const handmade = await writeSkill(await tempDir('handmade'), 'alpha', 'Handmade.')
    const root = await dshHome()
    await mkdir(root, { recursive: true })
    await createSkillLink(handmade, join(root, 'alpha'), 'directory')

    await mount({ sources: [], codex: { home: codex }, mcp: false })

    expect(await linksTo(join(root, 'alpha'), handmade)).toBe(true)
  })

  it('honors the skill cap the configuration sets', async () => {
    const codex = await skillHome('codex', ['alpha', 'beta'])
    const root = await dshHome()

    await mount({ sources: [], codex: { home: codex }, mcp: false, maxSkills: 1 })

    const names = await linkedNames(root)
    expect(names).toHaveLength(1)
    expect(['alpha', 'beta']).toContain(names[0])
  })
})

describe('apply — links across a reload', () => {
  it('keeps the links it made when the plugin is disposed and mounted again', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const root = await dshHome()
    const source = join(codex, 'skills', 'alpha')
    const fiber = await activate({ sources: [], codex: { home: codex }, mcp: false })
    expect(await linksTo(join(root, 'alpha'), source)).toBe(true)

    await fiber.dispose()

    // Disposal withdraws the mounted servers; what was installed is the user's.
    expect(await linkedNames(root)).toEqual(['alpha'])
    await mount({ sources: [], codex: { home: codex }, mcp: false })
    expect(await linksTo(join(root, 'alpha'), source)).toBe(true)
  })

  it('does not re-import a link the user removed when an unrelated edit reloads the entry', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const claude = await skillHome('claude', ['beta'])
    const root = await dshHome()
    const { ctx, live } = await mountLive({ sources: ['codex'], codex: { home: codex }, claudeCode: { configDir: claude }, mcp: false })
    expect(await linkedNames(root)).toEqual(['alpha', 'beta'])

    await rm(join(root, 'alpha'))
    // A skill the entry would import if it imported again.
    await writeSkill(join(codex, 'skills'), 'delta')
    // Editing the MCP sources leaves the enabled skill sources alone.
    await live.update({ sources: [] })
    // The report moving on is what proves the reload happened at all.
    await vi.waitFor(async () => { expect((await reportNow(ctx)).sources).toEqual([]) })

    expect(await linkedNames(root)).toEqual(['beta'])
  })

  it('imports the enabled set again when an edit changes which sources are enabled', async () => {
    const codex = await skillHome('codex', ['alpha'])
    const claude = await skillHome('claude', ['beta'])
    const root = await dshHome()
    const { live } = await mountLive({ sources: [], codex: { home: codex }, claudeCode: { configDir: claude }, mcp: false })
    expect(await linkedNames(root)).toEqual(['alpha', 'beta'])

    await rm(join(root, 'alpha'))
    await live.update({ skillSources: ['codex'] })

    // The change names the Codex root, so its skill is imported again — while the
    // link the sync never made is left where it is.
    await vi.waitFor(async () => { expect(await linkedNames(root)).toContain('alpha') })
    expect(await linkedNames(root)).toEqual(['alpha', 'beta'])
  })
})

/**
 * Read the skill catalog the plugin's route answers right now.
 * @param ctx - the context holding the plugin's recording webserver.
 * @returns the catalog the settings page would render.
 */
async function catalogNow(ctx: Context): Promise<SkillCatalog> {
  const webServer = ctx.get('webServer')
  // This file mounts the composition's only webserver, and mounts it as a recorder.
  if (!(webServer instanceof RecordingWebServer)) throw new Error('the composition has no recording webserver')
  const route = webServer.routes.find(candidate => candidate.path === SKILLS_PATH)
  if (route === undefined) throw new Error('the plugin registered no catalog route')
  let status = 0
  let body = ''
  // The route reads only the method and headers, so a stand-in response is
  // enough to read it without a socket.
  const req = { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } } as unknown as IncomingMessage
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  await route.handler(req, res)
  if (status !== 200) throw new Error(`the catalog route answered ${status}: ${body}`)
  return JSON.parse(body) as SkillCatalog
}

describe('apply — reading every source, importing the enabled ones', () => {
  it('offers a skill from a source nobody enabled, without importing it', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.gemini', 'skills'), 'gemini-only')
    const root = await dshHome()

    const { ctx } = await mountLive({ sources: [], skillSources: ['codex'], mcp: false })

    const row = (await catalogNow(ctx)).skills.find(skill => skill.name === 'gemini-only')
    expect(row?.state).toBe('available')
    expect(row?.candidates.map(candidate => candidate.source)).toEqual(['gemini'])
    // Read so the page can offer it, yes; imported without being asked, no.
    expect(await linkedNames(root)).toEqual([])
  })

  it('imports from any known source once that source is enabled', async () => {
    const home = await tempHome()
    const skill = await writeSkill(join(home, '.gemini', 'skills'), 'gemini-only')
    const root = await dshHome()

    await mount({ sources: [], skillSources: ['gemini'], mcp: false })

    expect(await linkedNames(root)).toEqual(['gemini-only'])
    expect(await linksTo(join(root, 'gemini-only'), skill)).toBe(true)
  })

  it('imports from an enabled source even when an unenabled one would rank higher', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.cc-switch', 'skills'), 'shared', 'Hub copy.')
    const codex = await skillHome('codex', ['shared'])
    const root = await dshHome()

    const { ctx } = await mountLive({ sources: [], codex: { home: codex }, skillSources: ['codex'], mcp: false })

    // Rank decides which candidate the page presents as the winner…
    const row = (await catalogNow(ctx)).skills.find(skill => skill.name === 'shared')
    expect(row?.candidates.map(candidate => `${candidate.source}${candidate.winner ? '*' : ''}`))
      .toEqual(['cc-switch*', 'codex'])
    // …while automatic import only takes from the sources it was told about, so
    // the copy it links is Codex's. Ticking `cc-switch` is what switches this.
    expect(await linkedNames(root)).toEqual(['shared'])
    expect(await linksTo(join(root, 'shared'), join(codex, 'skills', 'shared'))).toBe(true)
  })
})
