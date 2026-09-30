// @vitest-environment jsdom
/** Reading the Host half's import report from the page that renders the card. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAgentImportReport } from '../src/client/agent-import-report.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Stub the page's `fetch` with one answer. */
function stubFetch(answer: { ok: boolean; status: number; body?: unknown } | Error): void {
  vi.stubGlobal('fetch', vi.fn(() => {
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    })
  }))
}

describe('loadAgentImportReport', () => {
  it('reads the report the Host half answers', async () => {
    const report = {
      importedAt: '2026-09-30T00:00:00.000Z',
      sources: ['codex'],
      skills: [{ name: 'demo', description: 'Demo skill.', source: 'codex', path: '/home/u/.codex/skills/demo/SKILL.md' }],
      servers: [{ name: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'mounted' }],
      notes: [],
    }
    stubFetch({ ok: true, status: 200, body: report })

    expect(await loadAgentImportReport()).toEqual({ phase: 'ready', report })
  })

  it('reports the status when the route answers something else', async () => {
    stubFetch({ ok: false, status: 404, body: { error: 'not found' } })

    expect(await loadAgentImportReport()).toEqual({ phase: 'unavailable', reason: 'HTTP 404' })
  })

  it('refuses a payload the card cannot render', async () => {
    stubFetch({ ok: true, status: 200, body: { skills: 'everything' } })

    expect(await loadAgentImportReport()).toEqual({ phase: 'unavailable', reason: 'unexpected report payload' })
  })

  it('reports a read that never reached the route', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    expect(await loadAgentImportReport()).toEqual({ phase: 'unavailable', reason: 'TypeError: Failed to fetch' })
  })
})
