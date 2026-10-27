/**
 * The board's HTTP surface, driven handler by handler.
 *
 * Same guards as the workbench's own routes — same-origin reads, the
 * page-only header on writes — and the same refusal shapes for bad bodies
 * and unknown actions.
 *
 * @module @free-lzj/dsh-console/tests/workbench/routes
 */

import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { WORKBENCH_ACTION_PATH, WORKBENCH_INGEST_PATH, WORKBENCH_STATE_PATH } from '../../src/paths.ts'
import type { WorkbenchState } from '../../src/protocol.ts'
import { WorkbenchBoard } from '../../src/workbench/board.ts'
import { ClassifierRegistry, RuleClassifier } from '../../src/workbench/classifier.ts'
import { builtinConnectors, ConnectorRegistry } from '../../src/workbench/connectors.ts'
import { ExecutorRegistry, SimulatedExecutor } from '../../src/workbench/executors.ts'
import { defaultRoutingTable, RoutingTableStore } from '../../src/workbench/routing.ts'
import { registerWorkbenchRoutes } from '../../src/workbench/routes.ts'

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

/** What one bench recorded. */
interface Bench {
  routes: Map<string, Handler>
  board: WorkbenchBoard
}

/** Stand in for `ctx`, keeping the handlers the plugin registered. */
function bench(): Bench {
  const routes = new Map<string, Handler>()
  const classifiers = new ClassifierRegistry()
  classifiers.register(new RuleClassifier())
  const executors = new ExecutorRegistry()
  executors.register(new SimulatedExecutor('dsh', 'DSH（模拟）', 0))
  executors.register(new SimulatedExecutor('codex', 'Codex（模拟）', 0))
  const connectors = new ConnectorRegistry()
  for (const connector of builtinConnectors()) connectors.register(connector)
  const board = new WorkbenchBoard({
    classifiers,
    executors,
    connectors,
    routing: new RoutingTableStore(undefined, defaultRoutingTable(), () => {}),
    enabledConnectors: () => ['mail', 'webhook'],
    classifierId: () => 'rule',
    warn: () => {},
  })
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
    logger: { warn: () => {} },
    inject(names: readonly string[], fn: (inner: unknown) => void): void {
      expect(names).toContain('webServer')
      fn(scoped)
    },
  }
  registerWorkbenchRoutes(ctx as never, { board })
  return { routes, board }
}

/** Run one registered route. */
async function call(route: Bench, req: IncomingMessage): Promise<RecordedResponse> {
  const handler = route.routes.get(new URL(req.url ?? '/', 'http://x').pathname)
  expect(handler, `route ${req.url} is registered`).toBeTypeOf('function')
  const res = new RecordedResponse()
  await handler!(req, res as unknown as ServerResponse)
  return res
}

/** A same-origin POST with the page-only header. */
function write(url: string, body: unknown): IncomingMessage {
  return request({
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
    body: JSON.stringify(body),
  })
}

describe('workbench routes', () => {
  it('mounts the three paths the board speaks to', () => {
    const { routes } = bench()
    expect([...routes.keys()].sort()).toEqual(
      [WORKBENCH_ACTION_PATH, WORKBENCH_INGEST_PATH, WORKBENCH_STATE_PATH].sort(),
    )
  })

  it('answers state to a same-origin read', async () => {
    const route = bench()
    const res = await call(route, request({ url: WORKBENCH_STATE_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(200)
    expect((res.json as WorkbenchState).cards).toEqual([])
  })

  it('answers "unchanged" when the revision asked for is current', async () => {
    // 每两秒拉一次整份看板（含会话与日志）是纯粹的浪费：带上 revision 之后，
    // 没变的时候只回几十字节，页面也不重绘。
    const route = bench()
    const first = await call(route, request({ url: WORKBENCH_STATE_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    const revision = (first.json as WorkbenchState).revision
    const again = await call(route, request({
      url: `${WORKBENCH_STATE_PATH}?since=${String(revision)}`,
      headers: { 'sec-fetch-site': 'same-origin' },
    }))
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ unchanged: true, revision })
  })

  it('still answers the whole board when the revision moved', async () => {
    const route = bench()
    const stale = await call(route, request({
      url: `${WORKBENCH_STATE_PATH}?since=999`,
      headers: { 'sec-fetch-site': 'same-origin' },
    }))
    expect(stale.status).toBe(200)
    expect((stale.json as WorkbenchState).cards).toEqual([])
    expect(stale.json).not.toHaveProperty('unchanged')
  })

  it('refuses a method that is not a read', async () => {
    const route = bench()
    const res = await call(route, request({ url: WORKBENCH_STATE_PATH, method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET')
  })

  it('refuses a read from another site', async () => {
    const route = bench()
    const res = await call(route, request({ url: WORKBENCH_STATE_PATH, headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
  })

  it('refuses a write without the page-only header', async () => {
    const route = bench()
    const res = await call(route, request({
      url: WORKBENCH_INGEST_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'webhook', title: '页面报错' }),
    }))
    expect(res.status).toBe(403)
    expect(route.board.state().cards).toEqual([])
  })

  it('refuses a write that is not a POST', async () => {
    const route = bench()
    const res = await call(route, request({ url: WORKBENCH_INGEST_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('ingests an event through the route', async () => {
    const route = bench()
    const res = await call(route, write(WORKBENCH_INGEST_PATH, { source: 'webhook', title: '页面报错' }))
    expect(res.status).toBe(200)
    const body = res.json as { card?: { column?: string }; decision?: { routeId?: string } }
    expect(body.card?.column).toBe('processing')
    expect(body.decision?.routeId).toBe('bug-to-dsh')
  })

  it('refuses an unknown source and an empty title', async () => {
    const route = bench()
    expect((await call(route, write(WORKBENCH_INGEST_PATH, { source: 'smoke-signal', title: 'x' }))).status).toBe(400)
    expect((await call(route, write(WORKBENCH_INGEST_PATH, { source: 'webhook', title: '  ' }))).status).toBe(400)
    expect(route.board.state().cards).toEqual([])
  })

  it('runs a dispatch and refuses an unknown action and an unknown card', async () => {
    const route = bench()
    const ingested = await call(route, write(WORKBENCH_INGEST_PATH, { source: 'mail', title: '今天天气不错' }))
    const cardId = (ingested.json as { card: { id: string } }).card.id
    const dispatched = await call(route, write(WORKBENCH_ACTION_PATH, { action: 'dispatch', cardId }))
    expect(dispatched.status).toBe(200)
    expect((dispatched.json as { card: { column: string } }).card.column).toBe('processing')
    expect((await call(route, write(WORKBENCH_ACTION_PATH, { action: 'explode', cardId }))).status).toBe(400)
    expect((await call(route, write(WORKBENCH_ACTION_PATH, { action: 'dispatch', cardId: 'nope' }))).status).toBe(400)
  })
})
