/**
 * The two preferences the Host keeps about the home list, and the notice list it
 * keeps about itself.
 *
 * The Host deliberately holds **no catalog**: a panel is declared by its own
 * plugin's browser half, so the only panel facts here are two id lists. These
 * tests pin that split — including that an id the browser never mentioned is
 * still stored verbatim, because the Host is not the place that decides which
 * ids are real.
 *
 * @module @free-lzj/dsh-console/tests/console-host
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleHost } from '../src/console-host.ts'
import { STATE_DIR } from '../src/store.ts'

/** Homes created by one test, removed afterwards. */
const homes: string[] = []

/** @returns a fresh directory this test owns. */
async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-console-'))
  homes.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * Build a host over a temporary home.
 * @param root - the directory the preferences live below.
 * @returns the host.
 */
function bench(root: string): ConsoleHost {
  return new ConsoleHost(new Context(), {
    homeDir: root,
    channels: () => ['inapp'],
    layout: () => 'grid',
  })
}

describe('the Host state', () => {
  it('carries no panel catalog', () => {
    const host = bench('nowhere')
    expect(host.state()).toEqual({
      notices: [],
      // 待处理条目数由 Host 算，界面不自己数——所以它也在状态里。
      awaiting: 0,
      availableChannels: [],
      layout: 'grid',
      pinned: [],
      // 没接会话服务时首页只是少一块，不是坏掉。
      running: [],
      // 还没做过任何自动化的事。
      log: [],
      revision: 0,
    })
  })

  it('reports the channels it implements and which are on', () => {
    const host = bench('nowhere')
    host.channels.register({ id: 'inapp', plan: () => true, deliver: () => Promise.resolve(true) })
    host.channels.register({ id: 'sound', plan: () => true, deliver: () => Promise.resolve(true) })
    expect(host.state().availableChannels).toEqual([
      { id: 'inapp', enabled: true },
      { id: 'sound', enabled: false },
    ])
  })

  it('stores an id it has never seen, because the browser knows which ids exist', async () => {
    const host = bench(await home())
    await host.setPinned('plugin:nobody-declared-this', true)
    expect(host.state().pinned).toEqual(['plugin:nobody-declared-this'])
  })

  it('advances the revision on every change and pushes the new state', async () => {
    const host = bench(await home())
    await host.ready
    const seen: number[] = []
    host.subscribe((event) => {
      if (event.type === 'state') seen.push(event.state.revision)
    })
    await host.setPinned('a', true)
    await host.setPinned('b', true)
    expect(seen).toEqual([2, 3])
    expect(host.state().revision).toBe(3)
  })

  it('drops the notice list but keeps the preference', async () => {
    const host = bench(await home())
    await host.setPinned('a', true)
    await host.notify({ title: '一条' })
    host.clearNotices()
    const state = host.state()
    expect(state.notices).toEqual([])
    expect(state.pinned).toEqual(['a'])
  })
})

describe('preferences on disk', () => {
  it('survives a restart', async () => {
    const root = await home()
    await bench(root).setPinned('mail', true)

    const second = bench(root)
    await second.ready
    expect(second.state().pinned).toEqual(['mail'])
  })

  it('merges a click that beat the initial read onto what was on disk', async () => {
    const root = await home()
    await bench(root).setPinned('mail', true)

    // A fresh host starts empty and reads asynchronously. The click must not
    // persist a half-empty document over the pin the file already held.
    const second = bench(root)
    await second.setPinned('other', true)
    await second.ready
    expect(second.preferences().pinned).toEqual(['mail', 'other'])
  })

  it('falls back to empty rather than failing on a hand-edited file', async () => {
    const root = await home()
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(join(root, STATE_DIR, 'prefs.json'), '{ oops', 'utf8')
    const host = bench(root)
    await host.ready
    expect(host.preferences()).toEqual({ pinned: [] })
  })

  it('ignores values a hand-edited file put in the wrong shape', async () => {
    const root = await home()
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(join(root, STATE_DIR, 'prefs.json'), JSON.stringify({ pinned: ['a', 3, null], extra: 'ignored' }), 'utf8')
    const host = bench(root)
    await host.ready
    expect(host.preferences()).toEqual({ pinned: ['a'] })
  })

  it('writes the document the reader expects', async () => {
    const root = await home()
    const host = bench(root)
    await host.setPinned('mail', true)
    const raw = JSON.parse(await readFile(join(root, STATE_DIR, 'prefs.json'), 'utf8')) as unknown
    expect(raw).toEqual({ pinned: ['mail'] })
  })
})
