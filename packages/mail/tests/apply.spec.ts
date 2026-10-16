/**
 * The order in which the Host half starts its long-lived work.
 *
 * A plugin row is applied as soon as the loader reaches it, which is not the
 * same moment the credentials provider is mounted. Reading an authorization code
 * during that window answers "not configured" about a code that exists — the bug
 * that made a saved account fail to connect after a restart while the same
 * account connected fine when it was added at runtime.
 *
 * @module @free-lzj/dsh-mail/tests/apply
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

/** What the plugin asked of the context it was handed. */
interface Harness {
  readonly ctx: unknown
  /** Every `inject(names, …)` the plugin made, in order. */
  readonly injected: string[][]
  /** Running these stands in for the loader mounting the injected services. */
  readonly mountAll: () => void
  /** How many effects the plugin registered, directly or through an injection. */
  readonly effects: () => number
  readonly warnings: string[]
}

/**
 * A context that records injections instead of resolving them.
 * @returns the harness described above.
 */
function harness(): Harness {
  const injected: string[][] = []
  const callbacks: ((inner: unknown) => void)[] = []
  const warnings: string[] = []
  let effects = 0
  const ctx = {
    logger: {
      info: (): void => {},
      warn: (line: string): void => {
        warnings.push(line)
      },
    },
    // Nothing is mounted yet: the whole point of the exercise.
    get: (): undefined => undefined,
    inject(names: readonly string[], callback: (inner: unknown) => void): void {
      injected.push([...names])
      callbacks.push(callback)
    },
    effect(): () => void {
      effects += 1
      return () => {}
    },
  }
  return {
    ctx,
    injected,
    mountAll: () => {
      for (const callback of callbacks) {
        callback({
          effect: (): (() => void) => {
            effects += 1
            return () => {}
          },
        })
      }
    },
    effects: () => effects,
    warnings,
  }
}

const saved: string | undefined = process.env['DSH_HOME']

beforeEach(async () => {
  // Point the plugin at a scratch home so a test never reads the real state.
  process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'mail-apply-'))
})

afterEach(() => {
  if (saved === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = saved
})

describe('mounting the Host half', () => {
  it('waits for the credentials service before starting its connections', () => {
    const test = harness()
    apply(test.ctx as never)

    // The routes register immediately (they wait for webServer themselves), but
    // connection management must be gated on the code store being available.
    expect(test.injected).toContainEqual(['webServer'])
    expect(test.injected).toContainEqual(['credentials'])
  })

  it('starts that work once the injected service is mounted', () => {
    const test = harness()
    apply(test.ctx as never)
    const before = test.effects()

    test.mountAll()

    expect(test.effects()).toBeGreaterThan(before)
    // No accounts are configured in the scratch home, so nothing should have
    // complained on the way.
    expect(test.warnings.join('\n')).not.toContain('credentials')
  })
})
