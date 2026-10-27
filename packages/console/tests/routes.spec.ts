/**
 * The HTTP surface an open workbench speaks to, driven handler by handler.
 *
 * `dsh-host-webserver` adds no middleware, no body parsing and no origin policy
 * of its own, so this module owns all three decisions — and these tests check
 * exactly those: who may read, who may write, and what a body may contain.
 *
 * @module @free-lzj/dsh-console/tests/routes
 */

import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isMutationRequest, isSameOrigin, registerRoutes, type RouteHost } from '../src/routes.ts'
import { CONFIG_PATH, EVENTS_PATH, ITEM_PATH, STATE_PATH } from '../src/paths.ts'
import type { ConsoleHost } from '../src/console-host.ts'
import type { ConsoleState } from '../src/protocol.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** A response that records status, headers, and everything written. */
class RecordedResponse extends Writable {
  status = 0
  headers: Record<string, string> = {}
  headersSent = false
  private readonly chunks: Buffer[] = []

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = String(value)
  }

  writeHead(status: number, headers?: Record<string, unknown>): void {
    this.status = status
    this.headersSent = true
    for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = String(value)
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  /** Everything written so far, as text. */
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  /** Everything written so far, parsed as JSON. */
  get json(): unknown {
    return JSON.parse(this.text)
  }
}

/** A request that streams the given body with the headers a browser would send. */
function request(options: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const stream = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)])
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url,
    headers: { host: '127.0.0.1:10928', ...options.headers },
  }) as unknown as IncomingMessage
}

/** The state a route answers with in these tests. */
const STATE: ConsoleState = {
  notices: [],
  awaiting: 0,
  availableChannels: [{ id: 'desktop', enabled: true }, { id: 'inapp', enabled: true }],
  layout: 'grid',
  currentView: 'board',
  pinned: [],
  running: [],
  log: [],
  revision: 1,
}

/** What one bench recorded. */
interface Bench {
  routes: Map<string, Handler>
  written: unknown[]
  saved: { layout: string[]; view: string[]; channels: unknown[]; pinned: unknown[]; cleared: number }
  host: RouteHost
  detach: () => void
}

/**
 * Stand in for `ctx`, keeping the handlers the plugin registered.
 * @returns the context to hand `registerRoutes`, plus what the routes wrote.
 */
function bench(): Bench {
  const routes = new Map<string, Handler>()
  const written: unknown[] = []
  const saved = { layout: [] as string[], view: [] as string[], channels: [] as unknown[], pinned: [] as unknown[], cleared: 0 }
  const openGates: (() => void)[] = []
  const detach = (): void => {
    for (const close of openGates.splice(0)) close()
  }
  const host: RouteHost = {
    console: {
      presence: { open: () => { const close = (): void => {}; openGates.push(close); return close },
      },
      setPinned: (id: string, pinned: boolean) => {
        saved.pinned.push({ id, pinned })
        return Promise.resolve()
      },
      clearNotices: () => {
        saved.cleared += 1
      },
    } as unknown as ConsoleHost,
    state: () => STATE,
    setChannels: (channels) => {
      saved.channels.push([...channels])
      return Promise.resolve()
    },
    setLayout: (layout) => {
      saved.layout.push(layout)
      return Promise.resolve()
    },
    setView: (view) => {
      saved.view.push(view)
      return Promise.resolve()
    },
  }
  const scoped = {
    webServer: {
      register(route: { path: string; handler: Handler }): () => void {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(fn: () => unknown): () => void {
      fn()
      return () => {}
    },
  }
  const ctx = {
    logger: { warn: (line: string) => written.push(line) },
    inject(names: readonly string[], fn: (inner: unknown) => void): void {
      expect(names).toContain('webServer')
      fn(scoped)
    },
  }
  registerRoutes(ctx as never, host)
  return { routes, written, saved, host, detach }
}

/** Run one registered route. */
async function call(route: Benchmark, req: IncomingMessage): Promise<RecordedResponse> {
  const handler = route.routes.get(new URL(req.url ?? '/', 'http://x').pathname)
  expect(handler, `route ${req.url} is registered`).toBeTypeOf('function')
  const res = new RecordedResponse()
  await handler!(req, res as unknown as ServerResponse)
  return res
}

type Benchmark = Bench

describe('console routes', () => {
  it('mounts the four paths the page speaks to', () => {
    const { routes } = bench()
    expect([...routes.keys()].sort()).toEqual([CONFIG_PATH, EVENTS_PATH, ITEM_PATH, STATE_PATH].sort())
  })

  it('answers state to a same-origin read', async () => {
    const route = bench()
    const res = await call(route, request({ url: STATE_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(200)
    expect((res.json as ConsoleState).layout).toBe('grid')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('refuses a read from another site', async () => {
    const route = bench()
    const res = await call(route, request({ url: STATE_PATH, headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
  })

  it('refuses a write without the page-only header', async () => {
    const route = bench()
    const res = await call(route, request({
      url: CONFIG_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: 'list' }),
    }))
    expect(res.status).toBe(403)
    expect(route.saved.layout).toEqual([])
  })

  it('refuses a write that is not a POST', async () => {
    const route = bench()
    const res = await call(route, request({ url: CONFIG_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('saves a layout, a view, a channel set, a pin and a clear', async () => {
    const route = bench()
    const write = (body: unknown): Promise<RecordedResponse> => call(route, request({
      url: CONFIG_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
      body: JSON.stringify(body),
    }))
    expect((await write({ layout: 'compact' })).status).toBe(200)
    expect((await write({ view: 'focus' })).status).toBe(200)
    expect((await write({ channels: ['inapp'] })).status).toBe(200)
    expect((await write({ pinned: { id: 'mail', pinned: true } })).status).toBe(200)
    expect((await write({ notices: 'clear' })).status).toBe(200)
    expect(route.saved.layout).toEqual(['compact'])
    expect(route.saved.view).toEqual(['focus'])
    expect(route.saved.channels).toEqual([['inapp']])
    expect(route.saved.pinned).toEqual([{ id: 'mail', pinned: true }])
    expect(route.saved.cleared).toBe(1)
  })

  it('refuses an empty channel set, an unknown layout and an unknown view', async () => {
    const route = bench()
    const write = (body: unknown): Promise<RecordedResponse> => call(route, request({
      url: CONFIG_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
      body: JSON.stringify(body),
    }))
    expect((await write({ channels: [] })).status).toBe(400)
    expect((await write({ layout: 'fancy' })).status).toBe(400)
    // 一个更新的版本也许有别的视图，但这个构建没有——宁可拒绝，也不要存下一个没人认得的页。
    expect((await write({ view: 'timeline' })).status).toBe(400)
    expect((await write({ nothing: true })).status).toBe(400)
    expect(route.saved.layout).toEqual([])
    expect(route.saved.view).toEqual([])
  })

  it('answers a malformed body instead of throwing into the server', async () => {
    const route = bench()
    const res = await call(route, request({
      url: CONFIG_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
      body: '{ not json',
    }))
    expect(res.status).toBe(400)
  })
})

describe('request guards', () => {
  it('treats an unstated site and origin as the same origin', () => {
    expect(isSameOrigin(request({ url: STATE_PATH }))).toBe(true)
  })

  it('compares a stated origin against the addressed host', () => {
    expect(isSameOrigin(request({ url: STATE_PATH, headers: { origin: 'http://127.0.0.1:10928' } }))).toBe(true)
    expect(isSameOrigin(request({ url: STATE_PATH, headers: { origin: 'http://evil.example' } }))).toBe(false)
  })

  it('requires both the header and a JSON content type to write', () => {
    expect(isMutationRequest(request({ url: CONFIG_PATH, headers: { 'x-dsh-console': '1' } }))).toBe(false)
    expect(isMutationRequest(request({
      url: CONFIG_PATH,
      headers: { 'x-dsh-console': '1', 'content-type': 'application/json; charset=utf-8' },
    }))).toBe(true)
  })
})