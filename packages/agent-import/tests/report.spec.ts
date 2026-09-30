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
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as AgentImport from '../src/index.ts'
import { createReportHandler, NO_REPORT, REPORT_PATH } from '../src/report.ts'
import type { AgentImportReport } from '../src/report.ts'

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
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The report one route under test answers with. */
const REPORT: AgentImportReport = {
  importedAt: '2026-09-30T00:00:00.000Z',
  sources: ['codex'],
  skills: [{ name: 'demo', description: 'Demo skill.', source: 'codex', path: '/home/u/.codex/skills/demo/SKILL.md' }],
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
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-report-')))
  tempDirs.push(home)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), toml)
  return home
}

/** Create one skill directory holding an instruction file. */
async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}.\n---\n\nBody.\n`)
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
 * Mount the plugin with a webserver stand-in, then read the report its route answers.
 * @param input - the plugin configuration to activate with.
 * @returns the parsed report, and the routes the plugin registered.
 */
async function mounted(input: Parameters<typeof AgentImport.Config>[0]) {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(RecordingWebServer)
  await ctx.plugin(AgentImport, input)
  const routes = routesOf(ctx)
  const route = routes[0]
  if (route === undefined) throw new Error('the plugin registered no report route')
  const answer = await ask(route, { 'sec-fetch-site': 'same-origin' })
  return { routes, report: JSON.parse(answer.body) as AgentImportReport }
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

    expect(routes.map(route => [route.kind, route.path])).toEqual([['exact', REPORT_PATH]])
  })

  it('lists the skills the generation publishes, with their own source and path', async () => {
    const home = await codexHome('model = "gpt"\n')
    await writeSkill(join(home, 'skills'), 'demo')
    const { report } = await mounted({ sources: ['codex'], codex: { home }, mcp: false })

    expect(report.sources).toEqual(['codex'])
    expect(report.skills).toEqual([{
      name: 'demo', description: 'Skill demo.', source: 'codex', path: join(home, 'skills', 'demo', 'SKILL.md'),
    }])
    expect(report.importedAt).not.toBe('')
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
