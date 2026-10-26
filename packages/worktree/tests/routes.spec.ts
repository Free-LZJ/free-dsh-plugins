/**
 * The route layer: what each endpoint answers for a good request and for every
 * way a request is refused.
 *
 * The handlers are reached the way the Loader reaches them — by mounting the
 * plugin against a `webServer` service that records the registrations — so a
 * wrong path, a missing `kind`, or a guard that never runs fails here rather than
 * in a browser. Settings writes land in a temporary `DSH_HOME`, never the user's.
 *
 * @module @free-dsh/worktree/tests/routes
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  CREATE_PATH, MUTATION_HEADER, OVERVIEW_PATH, REMOVE_PATH, SETTINGS_PATH,
  type CreateWorktreeResult, type OverviewResult, type WorktreeSettings,
} from '../src/protocol.ts'
import { settingsFile } from '../src/store.ts'
import { cleanupRepositories, createManaged, repository, scratch } from './support/git-repository.ts'

/** One route the plugin registered. */
interface Registered {
  readonly kind: string
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** What a fake response collected. */
interface Answer {
  status: number
  body: string
}

/** Scratch harness homes this spec created. */
const homes: string[] = []
const originalHome = process.env.DSH_HOME

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-worktree-home-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  cleanupRepositories()
})

/**
 * Mount the plugin over a recording `webServer`, plus a Workspace registry the
 * overview reads.
 * @param directories - registered Workspace directories.
 * @returns the registrations, keyed by path.
 */
async function mount(directories: readonly string[] | undefined = []): Promise<Map<string, Registered>> {
  const ctx = new Context()
  const routes = new Map<string, Registered>()
  ctx.provide('webServer', {
    register: (route: Registered) => {
      routes.set(route.path, route)
      return () => {
        routes.delete(route.path)
      }
    },
  })
  // `undefined` mounts no registry at all: the profile shape that must degrade
  // instead of throwing.
  if (directories !== undefined) {
    ctx.provide('workspaceRegistry', {
      list: () => directories.map((path, index) => ({
        id: `ws-${index}`,
        path,
        title: path,
        sessionIds: [],
      })),
    })
  }
  await ctx.plugin({ apply }).await()
  return routes
}

/**
 * Read one route the plugin must have registered.
 * @param routes - the registrations.
 * @param path - route path.
 * @returns the registration.
 */
function route(routes: Map<string, Registered>, path: string): Registered {
  const found = routes.get(path)
  if (found === undefined) throw new Error(`no route registered for ${path}`)
  return found
}

/**
 * Call one route.
 * @param route - the registration.
 * @param options - method, query, headers and JSON body to present.
 * @returns the status and body the handler answered with.
 */
async function call(
  route: Registered,
  options: { method?: string; query?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Answer> {
  const text = options.body === undefined ? undefined : JSON.stringify(options.body)
  const query = options.query === undefined ? '' : `?${options.query}`
  const req = Object.assign(Readable.from(text === undefined ? [] : [text]), {
    method: options.method ?? 'POST',
    url: `${route.path}${query}`,
    headers: { host: '127.0.0.1:7951', ...options.headers },
  }) as unknown as IncomingMessage
  const answer: Answer = { status: 0, body: '' }
  // A plain mutable stand-in; only the members the route touches are present,
  // and the cast happens at the call so `headersSent` stays writable here.
  const res = {
    headersSent: false,
    setHeader: () => res,
    writeHead: (status: number) => {
      answer.status = status
      res.headersSent = true
      return res
    },
    end: (chunk?: string) => {
      answer.body = chunk ?? ''
      return res
    },
    destroy: () => undefined,
  }
  await route.handler(req, res as unknown as ServerResponse)
  return answer
}

/** Headers every mutating call needs. */
const MUTATION = { 'content-type': 'application/json', [MUTATION_HEADER]: '1' }

describe('the routes', () => {
  it('mounts exactly create, overview, remove and settings', async () => {
    const routes = await mount()
    expect([...routes.keys()].sort()).toEqual([CREATE_PATH, OVERVIEW_PATH, REMOVE_PATH, SETTINGS_PATH].sort())
    for (const entry of routes.values()) expect(entry.kind).toBe('exact')
  })
})

describe('overview', () => {
  it('groups the registered Workspaces by repository, one section per repository', async () => {
    const repo = repository()
    createManaged(repo, 'listed')
    // A second registered directory inside the same repository must not add a
    // second section.
    const nested = join(repo, '.agents', 'worktrees', 'listed')
    const routes = await mount([repo, nested])

    const answer = await call(route(routes, OVERVIEW_PATH), {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin' },
    })

    expect(answer.status).toBe(200)
    const result = JSON.parse(answer.body) as OverviewResult
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]?.repo).toBe(repo)
    expect(result.repos[0]?.worktrees.map(entry => entry.branch)).toContain('listed')
    expect(result.settings).toMatchObject({ parent: '', fetchBeforeCreate: true })
  })

  it('skips a Workspace that is not a repository instead of failing the read', async () => {
    const routes = await mount([scratch()])
    const answer = await call(route(routes, OVERVIEW_PATH), { method: 'GET', headers: {} })
    expect(answer.status).toBe(200)
    expect((JSON.parse(answer.body) as OverviewResult).repos).toEqual([])
  })

  it('answers an empty overview when no Workspace registry is mounted', async () => {
    // The regression this case exists for: reading the registry through the
    // `ctx.workspaceRegistry` accessor without an `inject` declaration throws
    // "cannot get property … without inject", so the page failed instead of
    // showing nothing.
    const routes = await mount(undefined)
    const answer = await call(route(routes, OVERVIEW_PATH), { method: 'GET', headers: {} })
    expect(answer.status).toBe(200)
    expect((JSON.parse(answer.body) as OverviewResult).repos).toEqual([])
  })

  it('refuses a method other than GET', async () => {
    const routes = await mount()
    const answer = await call(route(routes, OVERVIEW_PATH), { headers: MUTATION, body: {} })
    expect(answer.status).toBe(405)
  })
})

describe('settings', () => {
  it('answers the defaults before anything was written', async () => {
    const routes = await mount()
    const answer = await call(route(routes, SETTINGS_PATH), { method: 'GET', headers: {} })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ parent: '', fetchBeforeCreate: true })
  })

  it('persists a write and answers the settings now in effect', async () => {
    const routes = await mount()
    const parent = join(scratch(), 'checkouts')
    mkdirSync(parent, { recursive: true })

    const answer = await call(route(routes, SETTINGS_PATH), {
      headers: { 'sec-fetch-site': 'same-origin', ...MUTATION },
      body: { parent, fetchBeforeCreate: false },
    })

    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ parent, fetchBeforeCreate: false })
    const stored = JSON.parse(readFileSync(settingsFile(), 'utf8')) as WorktreeSettings
    expect(stored).toEqual({ parent, fetchBeforeCreate: false })
  })

  it('refuses a relative directory', async () => {
    const routes = await mount()
    const answer = await call(route(routes, SETTINGS_PATH), {
      headers: MUTATION,
      body: { parent: 'relative/path' },
    })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('绝对路径') })
  })

  it('refuses a write without the plugin header', async () => {
    const routes = await mount()
    const answer = await call(route(routes, SETTINGS_PATH), {
      headers: { 'content-type': 'application/json' },
      body: { fetchBeforeCreate: true },
    })
    expect(answer.status).toBe(403)
  })
})

describe('create', () => {
  it('creates a worktree for a same-origin JSON request', async () => {
    const repo = repository()
    const routes = await mount()

    const answer = await call(route(routes, CREATE_PATH), {
      headers: { 'sec-fetch-site': 'same-origin', ...MUTATION },
      body: { dir: repo, name: 'route-made' },
    })

    expect(answer.status).toBe(200)
    const result = JSON.parse(answer.body) as CreateWorktreeResult
    expect(result.branch).toBe('route-made')
    expect(result.base).toBe('HEAD')
    expect(result.path).toBe(join(repo, '.agents', 'worktrees', 'route-made'))
    // Git's own checkout rules decide the line endings here, so compare the text.
    expect(readFileSync(join(result.path, 'README.md'), 'utf8').trim()).toBe('hello')
  })

  it('honours the configured directory, one subdirectory per repository', async () => {
    const repo = repository()
    const parent = join(scratch(), 'checkouts')
    const routes = await mount()
    await call(route(routes, SETTINGS_PATH), {
      headers: MUTATION,
      body: { parent, fetchBeforeCreate: false },
    })

    const answer = await call(route(routes, CREATE_PATH), {
      headers: MUTATION,
      body: { dir: repo, name: 'outside' },
    })

    expect(answer.status).toBe(200)
    const result = JSON.parse(answer.body) as CreateWorktreeResult
    expect(result.path).toBe(join(parent, repo.split(/[\\/]/).pop() ?? '', 'outside'))
    expect(readFileSync(join(result.path, 'README.md'), 'utf8').trim()).toBe('hello')
  })

  it('refuses a write without the plugin header', async () => {
    const routes = await mount()
    const answer = await call(route(routes, CREATE_PATH), {
      headers: { 'content-type': 'application/json' },
      body: { dir: 'C:\\whatever' },
    })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining(MUTATION_HEADER) })
  })

  it('refuses another origin', async () => {
    const routes = await mount()
    const answer = await call(route(routes, CREATE_PATH), {
      headers: { 'sec-fetch-site': 'cross-site', ...MUTATION },
      body: { dir: 'C:\\whatever' },
    })
    expect(answer.status).toBe(403)
  })

  it('rejects a body without a directory', async () => {
    const routes = await mount()
    const answer = await call(route(routes, CREATE_PATH), { headers: MUTATION, body: { name: 'no-dir' } })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('dir') })
  })

  it('answers a Git failure as a 400 with the reason, not a crash', async () => {
    const routes = await mount()
    const answer = await call(route(routes, CREATE_PATH), {
      headers: MUTATION,
      body: { dir: scratch(), name: 'not-a-repo' },
    })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.any(String) })
  })
})

describe('remove', () => {
  it('removes a managed checkout for a same-origin JSON request', async () => {
    const repo = repository()
    const created = createManaged(repo, 'removable')
    const routes = await mount()

    const answer = await call(route(routes, REMOVE_PATH), {
      headers: { 'sec-fetch-site': 'same-origin', ...MUTATION },
      body: { dir: repo, path: created, deleteBranch: true },
    })

    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ removed: created, branch: 'removable' })
  })

  it('refuses a write without the plugin header', async () => {
    const routes = await mount()
    const answer = await call(route(routes, REMOVE_PATH), {
      headers: { 'content-type': 'application/json' },
      body: { dir: 'C:\\whatever', path: 'C:\\whatever' },
    })
    expect(answer.status).toBe(403)
  })

  it('rejects a body without a checkout path', async () => {
    const routes = await mount()
    const answer = await call(route(routes, REMOVE_PATH), { headers: MUTATION, body: { dir: 'C:\\whatever' } })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('path') })
  })
})
