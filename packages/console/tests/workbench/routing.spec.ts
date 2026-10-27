/**
 * The routing table: what it decides, and how it reloads.
 *
 * Two rules have no other guard: low confidence always holds, whatever any
 * rule says, and a malformed edit never replaces the last good table.
 *
 * @module @free-lzj/dsh-console/tests/workbench/routing
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchClassification } from '../../src/protocol.ts'
import {
  defaultRoutingTable, routeEvent, RoutingTableStore,
} from '../../src/workbench/routing.ts'

/** Homes created by one test, removed afterwards. */
const homes: string[] = []

afterEach(async () => {
  for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** @returns a fresh directory this test owns. */
async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-console-routing-'))
  homes.push(directory)
  return directory
}

/** One classification, with the fields a test cares about. */
function classification(overrides: Partial<WorkbenchClassification>): WorkbenchClassification {
  return {
    kind: 'bug',
    priority: 'normal',
    confidence: 0.9,
    reasons: [{ code: 'classify-none' }],
    ...overrides,
  }
}

describe('routeEvent', () => {
  it('records the route it matched as a code, not a sentence', () => {
    const decision = routeEvent(classification({}), {
      version: 'v1',
      rules: [{ id: 'bug-to-dsh', action: 'dispatch', executor: 'dsh', kinds: ['bug'] }],
    }, 'mail')
    expect(decision.reasons).toEqual([
      { code: 'classify-none' },
      { code: 'route-matched', params: { route: 'bug-to-dsh' } },
    ])
  })

  it('dispatches a confident bug to DSH', () => {
    const decision = routeEvent(classification({}), defaultRoutingTable(), 'webhook')
    expect(decision).toMatchObject({ action: 'dispatch', executor: 'dsh', routeId: 'bug-to-dsh' })
  })

  it('dispatches a confident requirement to Codex', () => {
    const decision = routeEvent(classification({ kind: 'requirement' }), defaultRoutingTable(), 'webhook')
    expect(decision).toMatchObject({ action: 'dispatch', executor: 'codex', routeId: 'requirement-to-codex' })
  })

  it('holds a consult for a reply instead of dispatching', () => {
    const decision = routeEvent(classification({ kind: 'consult' }), defaultRoutingTable(), 'webhook')
    expect(decision).toMatchObject({ action: 'reply-only', routeId: 'consult-reply-only' })
  })

  it('holds a low-confidence event before any rule can claim it', () => {
    const decision = routeEvent(classification({ confidence: 0.5 }), defaultRoutingTable(), 'webhook')
    expect(decision).toMatchObject({ action: 'hold', routeId: 'low-confidence' })
  })

  it('holds a kind no rule claims', () => {
    const decision = routeEvent(classification({ kind: 'unknown', confidence: 0.9 }), defaultRoutingTable(), 'webhook')
    expect(decision).toMatchObject({ action: 'hold', routeId: 'no-route' })
  })

  it('lets a rule raise the bar above the default threshold', () => {
    const table = {
      version: 'test',
      rules: [{ id: 'strict-bug', kinds: ['bug'], minConfidence: 0.95, action: 'dispatch' as const, executor: 'dsh' }],
    }
    const decision = routeEvent(classification({ confidence: 0.9 }), table, 'webhook')
    expect(decision).toMatchObject({ action: 'hold', routeId: 'no-route' })
  })
})

describe('RoutingTableStore', () => {
  it('writes the fallback when no file exists, then reads it back', async () => {
    const directory = await home()
    const path = join(directory, 'routing.json')
    const warned: string[] = []
    const store = new RoutingTableStore(path, defaultRoutingTable(), (line) => warned.push(line))
    await store.ensureFile(defaultRoutingTable())
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('workbench-routes-v1')
    expect((await store.current()).version).toBe('workbench-routes-v1')
    expect(warned).toEqual([])
  })

  it('creates the parent directory on a fresh home instead of failing silently', async () => {
    const directory = await home()
    // A fresh home has no dsh-console/ directory yet; the mount-time write
    // must not depend on the board's first write having created it.
    const path = join(directory, 'dsh-console', 'routing.json')
    const store = new RoutingTableStore(path, defaultRoutingTable(), () => {})
    await store.ensureFile(defaultRoutingTable())
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('workbench-routes-v1')
  })

  it('hot-reloads an edited file', async () => {
    const directory = await home()
    const path = join(directory, 'routing.json')
    await writeFile(path, JSON.stringify({ version: 'v2', rules: [] }))
    const store = new RoutingTableStore(path, defaultRoutingTable(), () => {})
    expect((await store.current()).version).toBe('v2')
    await writeFile(path, JSON.stringify({ version: 'v3', rules: [] }))
    expect((await store.current()).version).toBe('v3')
  })

  it('keeps the last good table when an edit is malformed, and warns once', async () => {
    const directory = await home()
    const path = join(directory, 'routing.json')
    await writeFile(path, JSON.stringify({ version: 'v2', rules: [] }))
    const warned: string[] = []
    const store = new RoutingTableStore(path, defaultRoutingTable(), (line) => warned.push(line))
    expect((await store.current()).version).toBe('v2')
    await writeFile(path, '{ not json')
    expect((await store.current()).version).toBe('v2')
    expect((await store.current()).version).toBe('v2')
    expect(warned).toHaveLength(1)
    await writeFile(path, JSON.stringify({ version: 'v3', rules: [] }))
    expect((await store.current()).version).toBe('v3')
  })
})
