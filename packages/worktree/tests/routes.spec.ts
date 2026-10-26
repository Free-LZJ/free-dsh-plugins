/**
 * The route layer: what each endpoint answers for a good request and for every
 * way a request is refused.
 *
 * The handlers are reached the way the Loader reaches them — by mounting the
 * plugin against a `webServer` service that records the registrations — so a
 * wrong path, a missing `kind`, or a guard that never runs fails here rather than
 * in a browser.
 *
 * @module @free-lzj/dsh-worktree/tests/routes
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  CREATE_PATH, LIST_PATH, MUTATION_HEADER, REMOVE_PATH,
  type CreateWorktreeResult, type ListWorktreesResult,
} from '../src/protocol.ts'
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

afterEach(cleanupRepositories)

/**
 * Mount the plugin over a recording `webServer`.
 * @returns the registrations, keyed by path.
 */
async function mount(): Promise<Map<string, Registered>> {
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
  it('mounts exactly create, list and remove', async () => {
    const routes = await mount()
    expect([...routes.keys()].sort()).toEqual([CREATE_PATH, LIST_PATH, REMOVE_PATH].sort())
    for (const entry of routes.values()) expect(entry.kind).toBe('exact')
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
    expect(result.path).toBe(join(repo, '.agents', 'worktrees', 'route-made'))
    // Git's own checkout rules decide the line endings here, so compare the text.
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

  it('refuses a method other than POST', async () => {
    const routes = await mount()
    const answer = await call(route(routes, CREATE_PATH), {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(answer.status).toBe(405)
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

describe('list', () => {
  it('answers the repository and its checkouts for a GET', async () => {
    const repo = repository()
    const created = await createManaged(repo, 'listed')
    const routes = await mount()

    const answer = await call(route(routes, LIST_PATH), {
      method: 'GET',
      query: new URLSearchParams({ dir: repo }).toString(),
      headers: { 'sec-fetch-site': 'same-origin' },
    })

    expect(answer.status).toBe(200)
    const result = JSON.parse(answer.body) as ListWorktreesResult
    expect(result.repo).toBe(repo)
    expect(result.worktrees.map(entry => entry.branch)).toContain('listed')
    expect(result.worktrees.find(entry => entry.branch === 'listed')?.path).toBe(created)
  })

  it('rejects a request without a directory', async () => {
    const routes = await mount()
    const answer = await call(route(routes, LIST_PATH), { method: 'GET', headers: {} })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('dir') })
  })

  it('refuses a method other than GET', async () => {
    const routes = await mount()
    const answer = await call(route(routes, LIST_PATH), { headers: MUTATION, body: { dir: 'C:\\whatever' } })
    expect(answer.status).toBe(405)
  })
})

describe('remove', () => {
  it('removes a managed checkout for a same-origin JSON request', async () => {
    const repo = repository()
    const created = await createManaged(repo, 'removable')
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
