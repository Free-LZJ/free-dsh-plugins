// @vitest-environment jsdom
/** The skill routes the Skills tab reads and steers, as they cross the wire. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadSkillCatalog, loadSkillContent, sendSkillImport, sendSkillRemoval, SKILL_CONTENT_PATH, SKILL_IMPORT_PATH,
  SKILL_REMOVE_PATH, SKILLS_PATH,
} from '../src/client/agent-import-skills.ts'
import { skillCatalog, skillOutcome } from './support/skills.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One answer for the page's `fetch`, recording every call it served. */
function stubFetch(answer: { ok: boolean; status: number; body?: unknown; json?: Error } | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (answer instanceof Error) return Promise.reject(answer)
    const failure = answer.json
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () => failure === undefined ? Promise.resolve(answer.body) : Promise.reject(failure),
    })
  }))
  return calls
}

describe('loadSkillCatalog', () => {
  it('reads the catalog the Host answers', async () => {
    const catalog = skillCatalog({ notes: ['no ~/.gemini here'] })
    const calls = stubFetch({ ok: true, status: 200, body: catalog })

    expect(await loadSkillCatalog()).toEqual({ phase: 'ready', catalog })
    expect(calls[0]?.url).toBe(SKILLS_PATH)
    expect(calls[0]?.init?.headers).toEqual({ accept: 'application/json' })
  })

  it('shows the error text a refused read carries', async () => {
    stubFetch({ ok: false, status: 404, body: { error: 'skill management is disabled by the skills setting' } })

    expect(await loadSkillCatalog()).toEqual({
      phase: 'unavailable',
      reason: 'skill management is disabled by the skills setting',
    })
  })

  it('falls back to the status when a refused read carries no error', async () => {
    stubFetch({ ok: false, status: 500, body: 'boom' })

    expect(await loadSkillCatalog()).toEqual({ phase: 'unavailable', reason: 'HTTP 500' })
  })

  it('marks a read that never reached the route as offline', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    expect(await loadSkillCatalog()).toEqual({
      phase: 'unavailable',
      reason: 'Failed to fetch',
      offline: true,
    })
  })

  it('refuses a payload the tab cannot render', async () => {
    stubFetch({ ok: true, status: 200, body: { skills: [{ name: 'demo' }], notes: [] } })

    expect(await loadSkillCatalog()).toEqual({ phase: 'unavailable', reason: 'unexpected catalog payload' })
  })

  it('refuses a body that is not JSON at all', async () => {
    stubFetch({ ok: true, status: 200, json: new SyntaxError('Unexpected token <') })

    expect(await loadSkillCatalog()).toEqual({ phase: 'unavailable', reason: 'Unexpected token <' })
  })
})

describe('loadSkillContent', () => {
  it('reads one body, naming the skill and the source to read it from', async () => {
    const content = {
      name: 'demo', description: 'Demo skill.', source: 'codex', file: '/home/u/.codex/skills/demo/SKILL.md', content: '# Demo\n',
    }
    const calls = stubFetch({ ok: true, status: 200, body: content })

    expect(await loadSkillContent({ name: 'demo', source: 'codex' })).toEqual({ phase: 'ready', content })
    expect(calls[0]?.url).toBe(`${SKILL_CONTENT_PATH}?name=demo&source=codex`)
  })

  it('leaves the source off when the installed copy is the one to read', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { name: 'demo', file: '/x/SKILL.md', content: '' } })

    expect(await loadSkillContent({ name: 'demo' })).toEqual({
      phase: 'ready',
      content: { name: 'demo', file: '/x/SKILL.md', content: '' },
    })
    expect(calls[0]?.url).toBe(`${SKILL_CONTENT_PATH}?name=demo`)
  })

  it('shows the error text when the body cannot be read', async () => {
    stubFetch({ ok: false, status: 404, body: { error: 'no skill named "gone"' } })

    expect(await loadSkillContent({ name: 'gone' })).toEqual({
      phase: 'unavailable',
      reason: 'no skill named "gone"',
    })
  })
})

describe('sendSkillImport', () => {
  it('posts the name, the source, and the replacement, marked as this page\u2019s own request', async () => {
    const result = skillOutcome({ removed: ['demo'], imported: ['demo'], notes: ['linked into ~/.dsh/skills'] })
    const calls = stubFetch({ ok: true, status: 200, body: { outcome: result } })

    expect(await sendSkillImport({ name: 'demo', source: 'cursor', replace: true })).toEqual({ phase: 'ready', outcome: result })
    expect(calls[0]?.url).toBe(SKILL_IMPORT_PATH)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-dsh-agent-import': '1',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'demo', source: 'cursor', replace: true })
  })

  it('sends nothing but the name when the winning copy is the one to import', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { outcome: skillOutcome({ imported: ['demo'] }) } })

    expect(await sendSkillImport({ name: 'demo' })).toEqual({ phase: 'ready', outcome: skillOutcome({ imported: ['demo'] }) })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'demo' })
  })

  it('shows the error text a refused write carries', async () => {
    const calls = stubFetch({ ok: false, status: 403, body: { error: 'cross-site mutation refused' } })

    expect(await sendSkillImport({ name: 'demo' })).toEqual({
      phase: 'unavailable',
      reason: 'cross-site mutation refused',
    })
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('marks a write that never reached the route as offline', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    expect(await sendSkillImport({ name: 'demo' })).toEqual({
      phase: 'unavailable',
      reason: 'Failed to fetch',
      offline: true,
    })
  })

  it('refuses an outcome the tab cannot render', async () => {
    stubFetch({ ok: true, status: 200, body: { outcome: { imported: 'all' } } })

    expect(await sendSkillImport({ name: 'demo' })).toEqual({
      phase: 'unavailable',
      reason: 'unexpected outcome payload',
    })
  })

  it('refuses an outcome whose skip reason has no copy to explain it', async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: { outcome: { imported: [], removed: [], notes: [], skipped: [{ name: 'demo', reason: 'who-knows' }] } },
    })

    expect(await sendSkillImport({ name: 'demo' })).toEqual({
      phase: 'unavailable',
      reason: 'unexpected outcome payload',
    })
  })
})

describe('sendSkillRemoval', () => {
  it('posts the name to the removal route', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { outcome: skillOutcome({ removed: ['demo'] }) } })

    expect(await sendSkillRemoval('demo')).toEqual({ phase: 'ready', outcome: skillOutcome({ removed: ['demo'] }) })
    expect(calls[0]?.url).toBe(SKILL_REMOVE_PATH)
    expect(calls[0]?.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-dsh-agent-import': '1',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'demo' })
  })

  it('carries what the Host left alone, with the reason it left it', async () => {
    const result = skillOutcome({
      skipped: [
        { name: 'demo', reason: 'not-a-link', detail: 'a real directory' },
        { name: 'dropped', reason: 'removed' },
      ],
      notes: ['automatic import will not bring this name back'],
    })
    stubFetch({ ok: true, status: 200, body: { outcome: result } })

    expect(await sendSkillRemoval('demo')).toEqual({ phase: 'ready', outcome: result })
  })
})
