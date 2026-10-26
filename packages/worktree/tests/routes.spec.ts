/**
 * The route layer: what the one HTTP endpoint answers for a good request and for
 * each way a request is refused.
 *
 * The handler is reached the way the Loader reaches it — by mounting the plugin
 * against a `webServer` service that records the registration — so a wrong path,
 * a missing `kind`, or a guard that never runs fails here rather than in a
 * browser.
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
import { CREATE_PATH, MUTATION_HEADER, type CreateWorktreeResult } from '../src/protocol.ts'
import { cleanupRepositories, repository, scratch } from './support/git-repository.ts'

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
 * Mount the plugin over a recording `webServer` and return the one route.
 * @returns the registration the Loader would have made.
 */
async function mount(): Promise<Registered> {
  const ctx = new Context()
  const routes: Registered[] = []
  ctx.provide('webServer', {
    register: (route: Registered) => {
      routes.push(route)
      return () => {
        routes.splice(routes.indexOf(route), 1)
      }
    },
  })
  await ctx.plugin({ apply }).await()
  const route = routes[0]
  if (route === undefined) throw new Error('the plugin registered no route')
  return route
}

/**
 * Call the route with one request.
 * @param route - the registered route.
 * @param options - method, headers and JSON body to present.
 * @returns the status and body the handler answered with.
 */
async function call(
  route: Registered,
  options: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Answer> {
  const text = options.body === undefined ? undefined : JSON.stringify(options.body)
  const req = Object.assign(Readable.from(text === undefined ? [] : [text]), {
    method: options.method ?? 'POST',
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

describe('the create route', () => {
  it('is registered as one exact path', async () => {
    const route = await mount()
    expect(route.kind).toBe('exact')
    expect(route.path).toBe(CREATE_PATH)
  })

  it('creates a worktree for a same-origin JSON request', async () => {
    const repo = repository()
    const route = await mount()

    const answer = await call(route, {
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
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
    const route = await mount()
    const answer = await call(route, {
      headers: { 'content-type': 'application/json' },
      body: { dir: 'C:\\whatever' },
    })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining(MUTATION_HEADER) })
  })

  it('refuses another origin', async () => {
    const route = await mount()
    const answer = await call(route, {
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
      body: { dir: 'C:\\whatever' },
    })
    expect(answer.status).toBe(403)
  })

  it('refuses a method other than POST', async () => {
    const route = await mount()
    const answer = await call(route, { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
    expect(answer.status).toBe(405)
  })

  it('rejects a body without a directory', async () => {
    const route = await mount()
    const answer = await call(route, {
      headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
      body: { name: 'no-dir' },
    })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.stringContaining('dir') })
  })

  it('answers a Git failure as a 400 with the reason, not a crash', async () => {
    const plain = scratch()
    const route = await mount()

    const answer = await call(route, {
      headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
      body: { dir: plain, name: 'not-a-repo' },
    })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ error: expect.any(String) })
  })
})
