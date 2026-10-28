/**
 * The HTTP surface only guards what it can guard itself.
 *
 * `dsh-host-webserver` adds no middleware, no body parsing and no origin policy,
 * so these tests drive the registered handlers directly and check the decisions
 * this module makes: who may read, who may write, and what a body may look like.
 *
 * @module @free-lzj/dsh-mail/tests/routes
 */

import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_BODY_BYTES, MUTATION_HEADER, isMutationRequest, isSameOrigin, readJsonBody, registerRoutes,
  type RouteHost,
} from '../src/routes.ts'
import {
  ACTION_PATH, ATTACHMENT_PATH, CONFIG_PATH, MESSAGE_PATH, MORE_PATH, PANEL_PATH, REFRESH_PATH, STATE_PATH,
} from '../src/paths.ts'
import type { MailState, RouteResult } from '../src/types.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** A response that records the status, headers and body it was handed. */
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

/**
 * Stand in for `ctx`, keeping the handlers the plugin registered.
 * @returns the context to hand `registerRoutes`, plus the captured handlers.
 */
function harness(): { ctx: never; routes: Map<string, Handler>; warnings: string[] } {
  const routes = new Map<string, Handler>()
  const warnings: string[] = []
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
    logger: { warn: (line: string) => warnings.push(line) },
    inject(names: readonly string[], fn: (inner: unknown) => void): void {
      expect(names).toContain('webServer')
      fn(scoped)
    },
  }
  return { ctx: ctx as never, routes, warnings }
}

/**
 * A request that streams the given body, with the headers a browser would send.
 * @param options - method, url, headers and body.
 * @returns the request.
 */
function request(options: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const req = {
    url: options.url,
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...options.headers },
    // Real IncomingMessages carry this; the oversized-body path calls it to drain.
    resume(): void {},
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  }
  return req as unknown as IncomingMessage
}

/** A host whose every operation is scripted. */
function host(overrides: Partial<RouteHost> = {}): RouteHost {
  const ok: RouteResult = { ok: true, applied: 1 }
  return {
    state: (): MailState => ({
      version: 1,
      revision: 1,
      collectedAt: '2026-01-01T00:00:00.000Z',
      accounts: [],
      mailboxes: [],
      messages: [],
      config: {
        fallbackScanSeconds: 300, maxListMessages: 100, maxWindowMessages: 2000, accounts: [],
        preferences: { loadRemoteImages: true, trustedSenders: [] },
      },
    }),
    detail: async () => undefined,
    attachment: async () => undefined,
    panelDocument: () => '<!doctype html><title>mail</title>',
    action: async () => ok,
    config: async () => ok,
    refresh: async () => ok,
    more: async () => ok,
    ...overrides,
  }
}

/**
 * Mount the routes for one test.
 * @param routeHost - the injected operations.
 * @returns the captured routes and a `call` that invokes one.
 */
function mounted(routeHost: RouteHost = host()) {
  const { ctx, routes, warnings } = harness()
  registerRoutes(ctx, routeHost)
  return {
    routes,
    warnings,
    call: async (path: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`no route registered for ${path}`)
      await handler(req, res)
    },
  }
}

const asJson = { [MUTATION_HEADER]: '1', 'content-type': 'application/json' }

describe('the same-origin guard', () => {
  it('accepts the page this server sent', () => {
    expect(isSameOrigin(request({ url: STATE_PATH }))).toBe(true)
    expect(isSameOrigin(request({ url: STATE_PATH, headers: { 'sec-fetch-site': 'none' } }))).toBe(true)
  })

  it('refuses another origin, and an origin that does not name this host', () => {
    expect(isSameOrigin(request({ url: STATE_PATH, headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false)
    expect(isSameOrigin(request({ url: STATE_PATH, headers: { origin: 'http://evil.example' } }))).toBe(false)
  })
})

describe('the mutation guard', () => {
  it('needs both the custom header and a JSON content type', () => {
    expect(isMutationRequest(request({ url: ACTION_PATH, method: 'POST', headers: asJson }))).toBe(true)
    expect(isMutationRequest(request({ url: ACTION_PATH, method: 'POST', headers: { 'content-type': 'application/json' } }))).toBe(false)
    expect(isMutationRequest(request({ url: ACTION_PATH, method: 'POST', headers: { [MUTATION_HEADER]: '1' } }))).toBe(false)
    expect(isMutationRequest(request({ url: ACTION_PATH, method: 'POST', headers: { [MUTATION_HEADER]: '1', 'content-type': 'text/plain' } }))).toBe(false)
  })
})

describe('reading a body', () => {
  it('parses JSON and refuses everything else', async () => {
    await expect(readJsonBody(request({ url: '/', body: '{"a":1}' }))).resolves.toEqual({ ok: true, value: { a: 1 } })
    await expect(readJsonBody(request({ url: '/', body: 'nope' }))).resolves.toMatchObject({ ok: false, status: 400 })
    await expect(readJsonBody(request({ url: '/', body: '   ' }))).resolves.toMatchObject({ ok: false, status: 400 })
  })

  it('stops a body larger than the cap', async () => {
    const big = `"${'x'.repeat(MAX_BODY_BYTES + 10)}"`
    await expect(readJsonBody(request({ url: '/', body: big }))).resolves.toMatchObject({ ok: false, status: 413 })
  })
})

describe('the registered routes', () => {
  it('registers exactly the paths the panel uses, all as exact routes', () => {
    const { routes } = mounted()
    for (const path of [
      PANEL_PATH, STATE_PATH, MESSAGE_PATH, ATTACHMENT_PATH, ACTION_PATH, CONFIG_PATH, REFRESH_PATH, MORE_PATH,
    ]) {
      expect(routes.has(path)).toBe(true)
    }
    expect(routes.size).toBe(8)
  })

  it('runs an older page through the same mutation guards as a refresh', async () => {
    const run = vi.fn(async () => ({ ok: true, added: 30, exhausted: false }) as RouteResult)
    const { call } = mounted(host({ more: run }))

    const accepted = new RecordedResponse()
    await call(
      MORE_PATH,
      request({ url: MORE_PATH, method: 'POST', headers: asJson, body: JSON.stringify({ folder: 'Archive' }) }),
      accepted as unknown as ServerResponse,
    )
    expect(accepted.status).toBe(200)
    // The folder the panel named is the folder the Host pages through.
    expect(run).toHaveBeenCalledWith({ folder: 'Archive' })
    expect(JSON.parse(accepted.text)).toMatchObject({ ok: true, added: 30, exhausted: false })

    // Reading history is a mutation like any other: another origin must not reach it.
    const refused = new RecordedResponse()
    await call(
      MORE_PATH,
      request({ url: MORE_PATH, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      refused as unknown as ServerResponse,
    )
    expect(refused.status).toBe(403)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('mirrors a page the Host could not open', async () => {
    const { call } = mounted(host({
      more: async () => ({ ok: false, code: 'folder_unavailable', message: '打不开文件夹「X」' }),
    }))
    const response = new RecordedResponse()
    await call(
      MORE_PATH,
      request({ url: MORE_PATH, method: 'POST', headers: asJson, body: '{}' }),
      response as unknown as ServerResponse,
    )
    expect(response.status).toBe(400)
    expect(JSON.parse(response.text)).toMatchObject({ ok: false, code: 'folder_unavailable' })
  })

  it('runs a refresh through the same mutation guards as an action', async () => {
    const run = vi.fn(async () => ({ ok: true }) as RouteResult)
    const { call } = mounted(host({ refresh: run }))

    const accepted = new RecordedResponse()
    await call(
      REFRESH_PATH,
      request({ url: REFRESH_PATH, method: 'POST', headers: asJson, body: '{}' }),
      accepted as unknown as ServerResponse,
    )
    expect(accepted.status).toBe(200)
    expect(run).toHaveBeenCalled()

    // Pressing a button is still a mutation: another origin must not reach it.
    const refused = new RecordedResponse()
    await call(
      REFRESH_PATH,
      request({ url: REFRESH_PATH, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      refused as unknown as ServerResponse,
    )
    expect(refused.status).toBe(403)
  })

  it('answers a poll that already holds the revision with a stub, not the list', async () => {
    const { call } = mounted()

    const fresh = new RecordedResponse()
    await call(STATE_PATH, request({ url: STATE_PATH }), fresh as unknown as ServerResponse)
    expect((JSON.parse(fresh.text) as MailState).revision).toBe(1)

    // The panel re-asks every couple of seconds; saying "unchanged" is what keeps
    // that from re-serialising the whole list each time.
    const repeated = new RecordedResponse()
    await call(STATE_PATH, request({ url: `${STATE_PATH}?since=1` }), repeated as unknown as ServerResponse)
    expect(JSON.parse(repeated.text)).toEqual({ unchanged: true, revision: 1 })

    // A stale revision still gets everything.
    const stale = new RecordedResponse()
    await call(STATE_PATH, request({ url: `${STATE_PATH}?since=0` }), stale as unknown as ServerResponse)
    expect((JSON.parse(stale.text) as MailState).messages).toBeDefined()
  })

  it('answers state as JSON without caching', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(STATE_PATH, request({ url: STATE_PATH }), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json).toMatchObject({ version: 1 })
  })

  it('serves the panel document under the panel policy', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(PANEL_PATH, request({ url: PANEL_PATH }), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.text).toContain('<!doctype html>')
  })

  it('refuses a cross-origin read before it reads anything', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(STATE_PATH, request({ url: STATE_PATH, headers: { 'sec-fetch-site': 'cross-site' } }), res as unknown as ServerResponse)
    expect(res.status).toBe(403)
  })

  it('needs accountId, folder and a positive uid to read a message', async () => {
    const { call } = mounted()
    for (const url of [
      MESSAGE_PATH,
      `${MESSAGE_PATH}?accountId=a&folder=INBOX`,
      `${MESSAGE_PATH}?accountId=a&folder=INBOX&uid=abc`,
      `${MESSAGE_PATH}?accountId=a&folder=INBOX&uid=0`,
    ]) {
      const res = new RecordedResponse()
      await call(MESSAGE_PATH, request({ url }), res as unknown as ServerResponse)
      expect(res.status).toBe(400)
    }
  })

  it('answers 404 for a message that is gone', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(MESSAGE_PATH, request({ url: `${MESSAGE_PATH}?accountId=a&folder=INBOX&uid=7` }), res as unknown as ServerResponse)
    expect(res.status).toBe(404)
  })

  it('answers 503 for a mailbox that is offline, not 500', async () => {
    const offline = Object.assign(new Error('mailbox m1 is not connected'), { code: 'account_offline' })
    const { call } = mounted(host({
      detail: async () => {
        throw offline
      },
    }))
    const res = new RecordedResponse()
    await call(MESSAGE_PATH, request({ url: `${MESSAGE_PATH}?accountId=a&folder=INBOX&uid=7` }), res as unknown as ServerResponse)
    expect(res.status).toBe(503)
    expect(res.json).toMatchObject({ code: 'account_offline' })
  })

  it('needs a part to download an attachment', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(ATTACHMENT_PATH, request({ url: `${ATTACHMENT_PATH}?accountId=a&folder=INBOX&uid=7` }), res as unknown as ServerResponse)
    expect(res.status).toBe(400)
  })

  it('rejects a non-POST mutation', async () => {
    const { call } = mounted()
    const res = new RecordedResponse()
    await call(ACTION_PATH, request({ url: ACTION_PATH, method: 'GET' }), res as unknown as ServerResponse)
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('POST')
  })

  it('rejects a POST that lacks the marks only our page makes', async () => {
    const { call } = mounted()
    for (const headers of [
      { 'content-type': 'application/json' },
      { [MUTATION_HEADER]: '1' },
      { [MUTATION_HEADER]: '1', 'content-type': 'text/plain' },
    ]) {
      const res = new RecordedResponse()
      await call(ACTION_PATH, request({ url: ACTION_PATH, method: 'POST', headers, body: '{"op":"markRead"}' }), res as unknown as ServerResponse)
      expect(res.status).toBe(403)
    }
  })

  it('runs an action and mirrors its failure status', async () => {
    const okRun = mounted(host({ action: async () => ({ ok: true, applied: 3 }) }))
    const okRes = new RecordedResponse()
    await okRun.call(ACTION_PATH, request({ url: ACTION_PATH, method: 'POST', headers: asJson, body: '{"op":"markRead"}' }), okRes as unknown as ServerResponse)
    expect(okRes.status).toBe(200)
    expect(okRes.json).toMatchObject({ ok: true, applied: 3 })

    const failRun = mounted(host({ action: async () => ({ ok: false, code: 'account_offline', message: 'down' }) }))
    const failRes = new RecordedResponse()
    await failRun.call(ACTION_PATH, request({ url: ACTION_PATH, method: 'POST', headers: asJson, body: '{"op":"markRead"}' }), failRes as unknown as ServerResponse)
    expect(failRes.status).toBe(400)
    expect(failRes.json).toMatchObject({ ok: false, code: 'account_offline' })
  })

  it('answers instead of escaping when an operation throws', async () => {
    const { call, warnings } = mounted(host({
      state: (): MailState => {
        throw new Error('boom secret detail')
      },
    }))
    const res = new RecordedResponse()
    await call(STATE_PATH, request({ url: STATE_PATH }), res as unknown as ServerResponse)
    expect(res.status).toBe(500)
    // The answer must not echo the failure text back to the page.
    expect(res.text).not.toContain('boom secret detail')
    expect(warnings.join('\n')).toContain('boom secret detail')
  })
})

describe('a streamed attachment', () => {
  it('is refused when it is gone, and the stream is never opened', async () => {
    const opened = vi.fn()
    const { call } = mounted(host({
      attachment: async () => {
        opened()
        return undefined
      },
    }))
    const res = new RecordedResponse()
    await call(ATTACHMENT_PATH, request({ url: `${ATTACHMENT_PATH}?accountId=a&folder=INBOX&uid=7&part=2` }), res as unknown as ServerResponse)
    expect(res.status).toBe(404)
    expect(opened).toHaveBeenCalled()
  })

  it('names the file in the disposition header and streams the bytes', async () => {
    const { call } = mounted(host({
      attachment: async () => ({
        filename: '发票 1.pdf',
        contentType: 'application/pdf',
        content: Readable.from([Buffer.from('%PDF-1.4')]),
      }),
    }))
    const res = new RecordedResponse()
    await call(ATTACHMENT_PATH, request({ url: `${ATTACHMENT_PATH}?accountId=a&folder=INBOX&uid=7&part=2` }), res as unknown as ServerResponse)
    // Give the pipe a tick to finish writing.
    await new Promise((resolve) => setImmediate(resolve))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('发票 1.pdf'))
    expect(res.text).toBe('%PDF-1.4')
  })
})
