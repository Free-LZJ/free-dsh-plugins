/**
 * The import report route: what the settings card reads back, and who may read it.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as AgentImport from '../src/index.ts'
import { createReportHandler, NO_REPORT, REPORT_PATH } from '../src/report.ts'
import type { AgentImportReport } from '../src/report.ts'
import { SKILLS_PATH, SKILL_CONTENT_PATH, SKILL_IMPORT_PATH, SKILL_REMOVE_PATH } from '../src/skill-routes.ts'

// The mount path hands declarations to another plugin, so this file records the
// configurations it receives instead of starting real servers. The real module's
// optional keys are declared because a Vitest mock namespace throws on a
// property it does not define.
vi.mock('@deepseek-ai/dsh-mcp-client', () => {
  const configSchema = Object.assign(
    (config: unknown) => config,
    { '~standard': { version: 1, vendor: 'agent-import-test', validate: (value: unknown) => ({ value }) } },
  )
  return {
    Config: configSchema,
    name: 'mcp-client',
    inject: [],
    provide: undefined,
    intercept: undefined,
    apply: () => {},
  }
})

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []

/** Values the environment held before this file redirected anything. */
const savedEnv = new Map<string, string | undefined>()

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Create one temp directory, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-report-')))
  tempDirs.push(dir)
  return dir
}

/** Point one environment variable at a temp directory for this test only. */
function redirect(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

/** The report one route under test answers with. */
const REPORT: AgentImportReport = {
  importedAt: '2026-09-30T00:00:00.000Z',
  sources: ['codex'],
  skills: [{ name: 'demo', description: 'Demo skill.', source: 'codex', path: '/home/u/.dsh/skills/demo/SKILL.md' }],
  servers: [{ name: 'demo', serverName: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'mounted' }],
  notes: [],
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

/** One response to one request against a throwaway server owning a route under test. */
interface Answer {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/**
 * Send one request to a route, over a real socket so the headers reach the handler verbatim.
 * @param route - the route to serve.
 * @param headers - request headers to send.
 * @param method - request method.
 * @returns the status, headers, and body the route answered with.
 */
async function ask(route: WebRoute, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<Answer>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: route.path, method, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      request.on('error', reject)
      request.end()
    })
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

/** Create one Codex home holding the given `config.toml`. */
async function codexHome(toml: string): Promise<string> {
  const home = await tempDir()
  await writeFile(join(home, 'config.toml'), toml)
  return home
}

/**
 * Create one skill directory holding an instruction file.
 * @param root - the skills root to create it under.
 * @param name - skill name.
 * @param description - description the instruction file declares.
 */
async function writeSkill(root: string, name: string, description = `Skill ${name}.`): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

/**
 * The routes a composition's webserver stand-in holds.
 * @param ctx - the composition to read.
 * @returns the routes registered so far.
 */
function routesOf(ctx: Context): readonly WebRoute[] {
  const webServer: unknown = ctx.get('webServer')
  // This file mounts the composition's only webserver, and mounts it as a recorder.
  if (!(webServer instanceof RecordingWebServer)) throw new Error('the composition has no recording webserver')
  return webServer.routes
}

/**
 * Mount the plugin with a webserver stand-in and a dsh home of its own, then read
 * the report its route answers.
 * @param input - the plugin configuration to activate with.
 * @param options - skills to place in dsh's own root before the plugin activates.
 * @returns the parsed report, the routes the plugin registered, and dsh's skill root.
 */
async function mounted(
  input: Parameters<typeof AgentImport.Config>[0],
  options: { readonly localSkills?: readonly string[] } = {},
) {
  // The plugin imports into `<DSH_HOME>/skills` and reads whichever Claude Code
  // home the environment names, so both must be temp directories here.
  const home = await tempDir()
  redirect('DSH_HOME', home)
  redirect('CLAUDE_CONFIG_DIR', await tempDir())
  for (const name of options.localSkills ?? []) await writeSkill(join(home, 'skills'), name, 'Mine.')
  const ctx = new Context()
  await ctx.plugin(RecordingWebServer)
  await ctx.plugin(AgentImport, input)
  const routes = routesOf(ctx)
  const route = routes.find(candidate => candidate.path === REPORT_PATH)
  if (route === undefined) throw new Error('the plugin registered no report route')
  const answer = await ask(route, { 'sec-fetch-site': 'same-origin' })
  return { routes, report: JSON.parse(answer.body) as AgentImportReport, skills: join(home, 'skills') }
}

describe('the report route', () => {
  it('answers the harness page and refuses another origin', async () => {
    const route: WebRoute = { kind: 'exact', path: REPORT_PATH, handler: createReportHandler(() => Promise.resolve(REPORT)) }

    const same = await ask(route, { 'sec-fetch-site': 'same-origin' })
    expect([same.status, JSON.parse(same.body)]).toEqual([200, REPORT])
    expect(same.headers['cache-control']).toBe('no-store')

    expect((await ask(route, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await ask(route, { origin: 'http://elsewhere.test' })).status).toBe(403)
    expect((await ask(route)).status).toBe(200)
  })

  it('accepts only a read', async () => {
    const route: WebRoute = { kind: 'exact', path: REPORT_PATH, handler: createReportHandler(() => Promise.resolve(REPORT)) }

    const posted = await ask(route, { 'sec-fetch-site': 'same-origin' }, 'POST')

    expect([posted.status, JSON.parse(posted.body)]).toEqual([405, { error: 'method not allowed' }])
  })

  it('answers a read that fails instead of leaving the request open', async () => {
    const route: WebRoute = { kind: 'exact', path: REPORT_PATH, handler: createReportHandler(() => Promise.reject(new Error('gone'))) }

    const answer = await ask(route, { 'sec-fetch-site': 'same-origin' })

    expect([answer.status, JSON.parse(answer.body)]).toEqual([500, { error: 'Error: gone' }])
  })

  it('reports nothing while no import generation is active', () => {
    expect(NO_REPORT).toEqual({ importedAt: '', sources: [], skills: [], servers: [], notes: [] })
  })
})

describe('the report the plugin publishes', () => {
  it('registers the report route of this plugin’s namespace', async () => {
    const home = await codexHome('model = "gpt"\n')
    const { routes } = await mounted({ sources: ['codex'], codex: { home }, mcp: false })

    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', REPORT_PATH],
      ['exact', SKILLS_PATH],
      ['exact', SKILL_CONTENT_PATH],
      ['exact', SKILL_IMPORT_PATH],
      ['exact', SKILL_REMOVE_PATH],
    ])
  })

  it('lists the skills dsh’s own root holds, with the source each came from', async () => {
    const home = await codexHome('model = "gpt"\n')
    await writeSkill(join(home, 'skills'), 'demo')
    const { report, skills } = await mounted({ sources: ['codex'], codex: { home }, mcp: false })

    expect(report.sources).toEqual(['codex'])
    // The path is where dsh loads the skill from, not the directory it came from.
    expect(report.skills).toEqual([{
      name: 'demo', description: 'Skill demo.', source: 'codex', path: join(skills, 'demo', 'SKILL.md'),
    }])
    expect(report.importedAt).not.toBe('')
  })

  it('lists a skill someone placed in dsh’s own root by hand', async () => {
    const home = await codexHome('model = "gpt"\n')
    const { report, skills } = await mounted(
      { sources: ['codex'], codex: { home }, mcp: false },
      { localSkills: ['mine'] },
    )

    expect(report.skills).toEqual([{
      name: 'mine', description: 'Mine.', source: 'dsh', path: join(skills, 'mine', 'SKILL.md'),
    }])
  })

  it('lists a mounted server by its command, without the arguments it was declared with', async () => {
    const home = await codexHome('[mcp_servers.demo]\ncommand = "demo-server"\nargs = ["--token", "secret"]\n')
    const { report } = await mounted({ sources: ['codex'], codex: { home } })

    expect(report.servers).toEqual([{
      name: 'demo', serverName: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'mounted',
    }])
  })

  it('keeps a server the deny list leaves unmounted in the report, with the reason', async () => {
    const home = await codexHome('[mcp_servers.demo]\ncommand = "demo-server"\n')
    const { report } = await mounted({ sources: ['codex'], codex: { home }, serverDenyList: ['demo'] })

    expect(report.servers).toEqual([{
      name: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'skipped', reason: 'listed in serverDenyList',
    }])
  })
})
