// @vitest-environment jsdom
/**
 * The page's half of the board poll.
 *
 * Two behaviours here are the whole point of the revision handshake: an unchanged
 * board costs a few dozen bytes and **no repaint** (readers are not notified), and
 * a hidden tab does not poll at all. Without them the workbench re-rendered its
 * whole card list every two seconds and kept doing it in a background tab.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/link-client
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKBENCH_STATE_PATH } from '../../src/paths.ts'
import { WorkbenchLink } from '../../src/client/workbench/link.ts'
import type { WorkbenchState } from '../../src/protocol.ts'

/** A minimal board payload. */
function state(revision: number): WorkbenchState {
  return { cards: [], sessions: [], connectors: [], routingVersion: 'v1', revision }
}

/** Replace `fetch` with one that answers the given bodies in order, recording the URLs. */
function stubFetch(bodies: readonly unknown[]): string[] {
  const urls: string[] = []
  const queue = [...bodies]
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const body = queue.shift() ?? { unchanged: true, revision: 0 }
    return { ok: true, json: async () => body } as Response
  })
  return urls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

describe('WorkbenchLink', () => {
  it('asks for the whole board first, then only for what changed', async () => {
    const urls = stubFetch([state(3), { unchanged: true, revision: 3 }])
    const link = new WorkbenchLink()
    await link.refresh()
    expect(urls[0]).toBe(WORKBENCH_STATE_PATH)
    expect(link.getSnapshot()?.revision).toBe(3)
    await link.refresh()
    expect(urls[1]).toBe(`${WORKBENCH_STATE_PATH}?since=3`)
  })

  it('does not notify readers when the board did not move', async () => {
    stubFetch([state(3), { unchanged: true, revision: 3 }])
    const link = new WorkbenchLink()
    const seen: number[] = []
    link.subscribe(() => seen.push(1))
    await link.refresh()
    expect(seen).toHaveLength(1)
    const before = link.getSnapshot()
    await link.refresh()
    // 同一个对象：选择器因此判等，整页不会重绘。
    expect(link.getSnapshot()).toBe(before)
    expect(seen).toHaveLength(1)
  })

  it('takes a changed board and repaints', async () => {
    stubFetch([state(3), state(4)])
    const link = new WorkbenchLink()
    const seen: number[] = []
    link.subscribe(() => seen.push(1))
    await link.refresh()
    await link.refresh()
    expect(link.getSnapshot()?.revision).toBe(4)
    expect(seen).toHaveLength(2)
  })

  it('does not poll while the tab is hidden', async () => {
    const urls = stubFetch([state(1)])
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const link = new WorkbenchLink()
    await link.refresh()
    expect(urls).toEqual([])
    expect(link.getSnapshot()).toBeUndefined()
  })
})
