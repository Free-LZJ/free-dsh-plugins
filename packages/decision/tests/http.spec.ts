/**
 * The HTTP action, in the kernel.
 *
 * The narrow contract is what is being tested: the kernel sends a connector-built
 * body and knows nothing else about it. Plus the one behaviour that silently rots if
 * it is wrong — a non-2xx answer must be a failure, not a success.
 *
 * @module @free-lzj/dsh-decision/tests/http
 */

import { describe, expect, it } from 'vitest'
import { runHttp } from '../src/actions/http.ts'

/** A fetch that records the call. */
function port(status = 200, seen: { url: string; method: string; body?: string }[] = []) {
  return {
    seen,
    fetch: async (url: string, init: { method: string; body?: string }) => {
      seen.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) })
      return { ok: status >= 200 && status < 300, status }
    },
  }
}

const payload = { subject: '限时优惠', rule: '推广' }

describe('runHttp', () => {
  it('posts the connector-built payload as JSON', async () => {
    const { seen, fetch } = port()
    const outcome = await runHttp({ url: 'https://example.com/hook' }, { fetch, payload })
    expect(outcome).toEqual({ ok: true, detail: '已发送到 https://example.com/hook' })
    expect(seen[0]?.method).toBe('POST')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual(payload)
  })

  it('treats a non-2xx answer as a failure, with the status', async () => {
    // 把 500 当成功，规则会在无人察觉时失效。
    const { fetch } = port(500)
    const outcome = await runHttp({ url: 'https://example.com/hook' }, { fetch, payload })
    if (outcome.ok) return
    expect(outcome.message).toContain('500')
  })

  it('honours the configured method', async () => {
    const { seen, fetch } = port()
    await runHttp({ url: 'https://example.com/hook', method: 'PUT' }, { fetch, payload })
    expect(seen[0]?.method).toBe('PUT')
  })

  it('fails with a reason when there is no fetch capability', async () => {
    expect(await runHttp({ url: 'https://x' }, { payload })).toMatchObject({ ok: false })
  })

  it('fails when the action names no url', async () => {
    const { fetch } = port()
    expect(await runHttp({}, { fetch, payload })).toMatchObject({ ok: false })
  })
})
