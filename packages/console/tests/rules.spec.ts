/**
 * The rule engine's HTTP surface, driven handler by handler.
 *
 * The guards are the workbench's own (`x-dsh-console: 1` plus a JSON content
 * type for a write, same-origin for everything), and the business side is a fake
 * engine: what these tests pin is that the page's eight verbs reach the engine
 * with the right arguments, that a refusal keeps its reason, and that nothing
 * here can be driven from another site.
 *
 * @module @free-dsh-plugins/dsh-console/tests/rules
 */

import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { registerRulesRoutes, type RulesEngine, type RulesRouteHost } from '../src/rules/index.ts'
import {
  RULES_CONDITION_PATH, RULES_ENABLE_PATH, RULES_MODE_PATH, RULES_PRIORITY_PATH, RULES_RUNS_PATH, RULES_STATE_PATH,
  RULES_TEST_PATH, RULES_UNDO_PATH,
} from '../src/paths.ts'

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

  /** Everything written so far, parsed as JSON. */
  get json(): unknown {
    return JSON.parse(Buffer.concat(this.chunks).toString('utf8')) as unknown
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

/** What the fake engine was asked to do. */
interface Engaged {
  readonly enabled: { ruleId: string; enabled: boolean }[]
  readonly modes: { ruleId: string; actionIndex: number; mode: string }[]
  readonly conditions: { ruleId: string; conditionIndex: number; values: readonly string[] }[]
  readonly priority: { ruleId: string; direction: string }[]
  readonly undo: string[]
  readonly tests: { accountId: string; folder: string; uid: number }[]
  readonly since: (string | undefined)[]
}

/** What one bench recorded. */
interface Bench {
  readonly routes: Map<string, Handler>
  readonly written: string[]
  readonly engaged: Engaged
}

/** The rule file the fake engine reports. */
const VIEW = {
  rules: [{ id: 'first', name: '第一条', enabled: true, priority: 10, when: [], then: [{ kind: 'mark' }] }],
  source: 'file' as const,
  path: 'C:/dsh/dsh-console/rules/rules.yml',
  raw: '- id: first\n',
  dropped: [],
  connector: true,
}

/**
 * Stand in for `ctx`, keeping the handlers the plugin registered.
 * @param overrides - engine verbs to replace (a refusal, a throwing read).
 * @returns the routes and what the engine saw.
 */
function bench(overrides: Partial<RulesEngine> = {}): Bench {
  const routes = new Map<string, Handler>()
  const written: string[] = []
  const engaged: Engaged = { enabled: [], modes: [], conditions: [], priority: [], undo: [], tests: [], since: [] }
  const engine: RulesEngine = {
    view: () => VIEW,
    setEnabled: (ruleId, enabled) => {
      engaged.enabled.push({ ruleId, enabled })
      return Promise.resolve({ ok: true })
    },
    setMode: (ruleId, actionIndex, mode) => {
      engaged.modes.push({ ruleId, actionIndex, mode })
      return Promise.resolve({ ok: true })
    },
    setConditionValues: (ruleId, conditionIndex, values) => {
      engaged.conditions.push({ ruleId, conditionIndex, values })
      return Promise.resolve({ ok: true })
    },
    movePriority: (ruleId, direction) => {
      engaged.priority.push({ ruleId, direction })
      return Promise.resolve({ ok: true })
    },
    listRuns: (since) => {
      engaged.since.push(since)
      return [{
        id: 'run-1', at: '2026-10-27T08:00:00.000Z', ruleId: 'first', ruleName: '第一条', label: '第一条',
        event: { subject: 'x' }, actions: [], status: 'done' as const,
      }]
    },
    undo: (runId) => {
      engaged.undo.push(runId)
      return Promise.resolve({ ok: true })
    },
    test: (ref) => {
      engaged.tests.push(ref)
      return Promise.resolve({ ok: true, result: { ruleId: 'first', ruleName: '第一条', actions: [], reason: '命中第一条。' } })
    },
    ...overrides,
  }
  const host: RulesRouteHost = { engine }
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
  registerRulesRoutes(ctx as never, host)
  return { routes, written, engaged }
}

/** Run one registered route. */
async function call(route: Bench, req: IncomingMessage): Promise<RecordedResponse> {
  const handler = route.routes.get(new URL(req.url ?? '/', 'http://x').pathname)
  expect(handler, `route ${req.url} is registered`).toBeTypeOf('function')
  const res = new RecordedResponse()
  await handler!(req, res as unknown as ServerResponse)
  return res
}

/** One write, as the page makes it. */
function write(route: Bench, path: string, body: unknown): Promise<RecordedResponse> {
  return call(route, request({
    url: path,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
    body: JSON.stringify(body),
  }))
}

describe('the rule engine’s routes', () => {
  it('mounts every path the page speaks to', () => {
    const { routes } = bench()
    expect([...routes.keys()].sort()).toEqual([
      RULES_CONDITION_PATH, RULES_ENABLE_PATH, RULES_MODE_PATH, RULES_PRIORITY_PATH, RULES_RUNS_PATH, RULES_STATE_PATH,
      RULES_TEST_PATH, RULES_UNDO_PATH,
    ].sort())
  })

  it('answers the rule file to a same-origin read', async () => {
    const route = bench()
    const res = await call(route, request({ url: RULES_STATE_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ connector: true, path: 'C:/dsh/dsh-console/rules/rules.yml' })
  })

  it('refuses a read from another site', async () => {
    const route = bench()
    const res = await call(route, request({ url: RULES_STATE_PATH, headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
  })

  it('refuses a write without the page-only header', async () => {
    const route = bench()
    const res = await call(route, request({
      url: RULES_ENABLE_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleId: 'first', enabled: false }),
    }))
    expect(res.status).toBe(403)
    expect(route.engaged.enabled).toEqual([])
  })

  it('refuses a write that is not a POST', async () => {
    const route = bench()
    const res = await call(route, request({ url: RULES_ENABLE_PATH, headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('passes each write through to the engine with its arguments', async () => {
    const route = bench()
    expect((await write(route, RULES_ENABLE_PATH, { ruleId: 'first', enabled: false })).status).toBe(200)
    expect((await write(route, RULES_MODE_PATH, { ruleId: 'first', actionIndex: 2, mode: 'suggest' })).status).toBe(200)
    expect((await write(route, RULES_CONDITION_PATH, { ruleId: 'first', conditionIndex: 1, values: ['a', 7] })).status).toBe(200)
    expect((await write(route, RULES_PRIORITY_PATH, { ruleId: 'first', direction: 'up' })).status).toBe(200)
    expect((await write(route, RULES_UNDO_PATH, { runId: 'run-1' })).status).toBe(200)

    expect(route.engaged.enabled).toEqual([{ ruleId: 'first', enabled: false }])
    expect(route.engaged.modes).toEqual([{ ruleId: 'first', actionIndex: 2, mode: 'suggest' }])
    // 非字符串的值被丢掉，而不是让引擎拿到一个它读不懂的列表。
    expect(route.engaged.conditions).toEqual([{ ruleId: 'first', conditionIndex: 1, values: ['a'] }])
    expect(route.engaged.priority).toEqual([{ ruleId: 'first', direction: 'up' }])
    expect(route.engaged.undo).toEqual(['run-1'])
  })

  it('rejects a write whose body is missing a required field', async () => {
    const route = bench()
    expect((await write(route, RULES_ENABLE_PATH, {})).status).toBe(400)
    expect((await write(route, RULES_MODE_PATH, { ruleId: 'first', mode: 'auto' })).status).toBe(400)
    expect((await write(route, RULES_CONDITION_PATH, { ruleId: 'first' })).status).toBe(400)
    expect((await write(route, RULES_PRIORITY_PATH, { ruleId: 'first', direction: 'sideways' })).status).toBe(400)
    expect((await write(route, RULES_UNDO_PATH, {})).status).toBe(400)
    expect(route.engaged.enabled).toEqual([])
  })

  it('hands back the engine’s reason when it refuses', async () => {
    const route = bench({ setEnabled: async () => ({ ok: false, message: '规则文件是只读的' }) })
    const res = await write(route, RULES_ENABLE_PATH, { ruleId: 'first', enabled: true })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: '规则文件是只读的' })
  })

  it('answers the hit records, and narrows them with ?since', async () => {
    const route = bench()
    const res = await call(route, request({ url: `${RULES_RUNS_PATH}?since=run-9` }))
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ runs: [{ id: 'run-1' }] })
    expect(route.engaged.since).toEqual(['run-9'])
  })

  it('runs the rules against one event and answers the verdict', async () => {
    const route = bench()
    const res = await write(route, RULES_TEST_PATH, { accountId: 'qq', folder: 'INBOX', uid: 7 })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ruleId: 'first' })
    expect(route.engaged.tests).toEqual([{ accountId: 'qq', folder: 'INBOX', uid: 7 }])
  })

  it('refuses a dry run without a mailbox reference, and reports one that cannot be made', async () => {
    const route = bench({ test: async () => ({ ok: false, message: '这封邮件已经不在了' }) })
    expect((await write(route, RULES_TEST_PATH, { accountId: 'qq', folder: 'INBOX' })).status).toBe(400)
    const res = await write(route, RULES_TEST_PATH, { accountId: 'qq', folder: 'INBOX', uid: 7 })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: '这封邮件已经不在了' })
  })

  it('answers a malformed body instead of throwing into the server', async () => {
    const route = bench()
    const res = await call(route, request({
      url: RULES_ENABLE_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-console': '1' },
      body: '{ not json',
    }))
    expect(res.status).toBe(400)
  })

  it('keeps a throwing read inside the route and logs it', async () => {
    const route = bench({ view: () => { throw new Error('disk on fire') } })
    const res = await call(route, request({ url: RULES_STATE_PATH }))
    expect(res.status).toBe(500)
    expect(route.written.some(line => line.includes('disk on fire'))).toBe(true)
  })
})
