/**
 * The order in which the Host half starts its long-lived work, and how one
 * scanned message is handed over.
 *
 * The first half of that is a plugin-row problem: a row is applied as soon as
 * the loader reaches it, which is not the same moment the credentials provider
 * is mounted. Reading an authorization code during that window answers "not
 * configured" about a code that exists — the bug that made a saved account fail
 * to connect after a restart while the same account connected fine when it was
 * added at runtime.
 *
 * The second half is the one decision the scan makes per message: there is no
 * IMAP session here, so `handOver` is driven directly with fakes. New mail has
 * exactly one destination — the triage engine — and the ledger write is what
 * keeps a failing rule from replaying the same message.
 *
 * @module @free-lzj/dsh-mail/tests/apply
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, handOver, type HandoverDeps } from '../src/index.ts'
import type { MailReceivedPayload, MailSummary, NormalizedMessage } from '../src/types.ts'

/** What the plugin asked of the context it was handed. */
interface Harness {
  readonly ctx: unknown
  /** Every `inject(names, …)` the plugin made, in order. */
  readonly injected: string[][]
  /** Running these stands in for the loader mounting the injected services. */
  readonly mountAll: () => void
  /** How many effects the plugin registered, directly or through an injection. */
  readonly effects: () => number
  /** Every service the plugin provided, by name. */
  readonly provided: string[]
  readonly warnings: string[]
}

/**
 * A context that records injections instead of resolving them.
 * @returns the harness described above.
 */
function harness(): Harness {
  const injected: string[][] = []
  const callbacks: ((inner: unknown) => void)[] = []
  const provided: string[] = []
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
    provide(name: string): void {
      provided.push(name)
    },
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
    provided,
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

  it('registers the mail service other plugins read through `ctx.get`', () => {
    const test = harness()
    apply(test.ctx as never)

    // Provided once, as a service: that is what makes the name injectable and
    // what removes it again when this plugin's own fiber unloads.
    expect(test.provided).toEqual(['mail'])
  })
})

/* ─────────────────────────── handing a message over ────────────────────── */

/** One list row, shaped the way a scan produces them. */
function scanned(over: Partial<MailSummary> = {}): NormalizedMessage {
  return {
    summary: {
      accountId: 'acc-1',
      folder: 'INBOX',
      uid: 42,
      uidValidity: 7,
      subject: 'Build failed',
      from: { name: 'CI Bot', address: 'ci@example.com' },
      date: '2024-05-01T10:00:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      snippet: 'nightly job failed',
      headers: { 'list-id': 'owner/repo <repo.owner.github.com>' },
      ...over,
    },
    preview: 'a two-kilobyte preview',
  }
}

/** The knobs a hand-over test drives, plus what the fakes recorded. */
function deps(over: Partial<HandoverDeps> = {}): {
  readonly deps: HandoverDeps
  readonly steps: string[]
  readonly emitted: MailReceivedPayload[]
  readonly triggered: string[]
} {
  const steps: string[] = []
  const emitted: MailReceivedPayload[] = []
  const triggered: string[] = []
  const base: HandoverDeps = {
    accountId: 'acc-1',
    accountName: '我的 QQ 邮箱',
    uidValidity: 7,
    ledger: {
      isTriggered: (_accountId, key) => {
        steps.push('isTriggered')
        return triggered.includes(key)
      },
      markTriggered: async (_accountId, key) => {
        steps.push('markTriggered')
        triggered.push(key)
      },
    },
    readBody: async () => {
      steps.push('readBody')
      return 'the whole message'
    },
    emit: (payload) => {
      steps.push('emit')
      emitted.push(payload)
    },
    ...over,
  }
  return { deps: base, steps, emitted, triggered }
}

describe('handOver', () => {
  it('emits mail/received, which is the one place new mail goes', async () => {
    const test = deps()
    await handOver(scanned(), test.deps)

    expect(test.steps).toEqual(['isTriggered', 'markTriggered', 'emit'])
    expect(test.emitted).toHaveLength(1)
    const payload = test.emitted[0]
    expect(payload?.accountId).toBe('acc-1')
    expect(payload?.accountName).toBe('我的 QQ 邮箱')
    expect(payload?.summary.uid).toBe(42)
    // The headers the triage rules decide on travel with the message.
    expect(payload?.summary.headers['list-id']).toBe('owner/repo <repo.owner.github.com>')
  })

  it('writes the ledger before emitting, so a listener that throws cannot replay', async () => {
    const test = deps()
    const listener = vi.fn(() => {
      throw new Error('engine blew up')
    })
    const boom = handOver(scanned(), {
      ...test.deps,
      emit: (payload) => {
        test.deps.emit(payload)
        listener()
      },
    })

    // A synchronous listener throw comes back out of `emit`, and this pass
    // reports it — that is the event bus's contract, not something to swallow.
    await expect(boom).rejects.toThrow('engine blew up')
    expect(listener).toHaveBeenCalledOnce()
    // What matters is the other half: the ledger was already written, so the
    // engine's failure does not turn into a replay of the same message.
    expect(test.triggered).toHaveLength(1)
    await handOver(scanned(), test.deps)
    expect(test.emitted).toHaveLength(1)
  })

  it('reads the body lazily, and only once, for whoever asks for it', async () => {
    const test = deps()
    await handOver(scanned(), test.deps)

    // Emitting is not reading: a rule decided on the headers must not pay for
    // the FETCH the body would need.
    expect(test.steps).not.toContain('readBody')
    const read = test.emitted[0]?.readBody
    await expect(read?.()).resolves.toBe('the whole message')
    await expect(read?.()).resolves.toBe('the whole message')
    expect(test.steps.filter(step => step === 'readBody')).toHaveLength(1)
  })

  it('emits nothing for a message the ledger already holds', async () => {
    const test = deps()
    await handOver(scanned(), test.deps)
    await handOver(scanned(), test.deps)

    expect(test.emitted).toHaveLength(1)
    expect(test.steps.filter(step => step === 'markTriggered')).toHaveLength(1)
  })
})
