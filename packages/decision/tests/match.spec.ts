/**
 * Rule matching, in the kernel.
 *
 * The lazy body read is the behaviour worth pinning: a body is the expensive step, so
 * it must be fetched at most once per pass and only when a condition actually needs it.
 * The second is honesty: a rule naming a condition this deployment lacks is a
 * configuration answer, not a quiet "no".
 *
 * @module @free-lzj/dsh-decision/tests/match
 */

import { describe, expect, it } from 'vitest'
import { ruleMatches, type MatchState } from '../src/match.ts'
import { ConditionRegistry, type Condition } from '../src/registry.ts'

interface Spec { readonly kind: string; readonly wantsBody?: boolean }
interface Ctx { readonly body?: string }

/** A condition that answers whatever the test says. */
function condition(kind: string, answer: boolean, needsBody = false): Condition<Spec, Ctx> {
  return {
    kind,
    needsBody,
    needsBodyFor: (spec) => spec.wantsBody === true,
    test: async () => answer,
  }
}

/** A registry plus the counters a test watches. */
function bench(defs: readonly Condition<Spec, Ctx>[]) {
  const registry = new ConditionRegistry<Spec, Ctx>()
  for (const def of defs) registry.register(def)
  const reads = { count: 0 }
  const lines: string[] = []
  return {
    reads,
    lines,
    plan: {
      conditions: registry,
      context: (state: MatchState) => (state.body === undefined ? {} : { body: state.body }),
      readBody: async () => {
        reads.count += 1
        return '正文'
      },
      log: (line: string) => lines.push(line),
    },
  }
}

describe('ruleMatches', () => {
  it('holds when every condition holds', async () => {
    const { plan } = bench([condition('a', true), condition('b', true)])
    expect(await ruleMatches({ name: 'r', when: [{ kind: 'a' }, { kind: 'b' }] }, plan)).toBe(true)
  })

  it('stops at the first condition that does not hold', async () => {
    const seen: string[] = []
    const { plan } = bench([
      condition('a', false, true),
      { kind: 'b', needsBody: true, test: async () => { seen.push('b'); return true } },
    ])
    expect(await ruleMatches({ name: 'r', when: [{ kind: 'a' }, { kind: 'b' }] }, plan)).toBe(false)
    expect(seen).toEqual([])
  })

  it('reads the body at most once, and only when a condition wants it', async () => {
    const { plan, reads } = bench([condition('a', true, true), condition('b', true, true)])
    await ruleMatches({ name: 'r', when: [{ kind: 'a' }, { kind: 'b' }] }, plan)
    expect(reads.count).toBe(1)
  })

  it('does not read the body when nothing asks for it', async () => {
    const { plan, reads } = bench([condition('a', true)])
    await ruleMatches({ name: 'r', when: [{ kind: 'a' }] }, plan)
    expect(reads.count).toBe(0)
  })

  it('honours a per-config body need', async () => {
    const { plan, reads } = bench([condition('a', true)])
    await ruleMatches({ name: 'r', when: [{ kind: 'a', wantsBody: true }] }, plan)
    expect(reads.count).toBe(1)
  })

  it('treats a condition this deployment lacks as a no, and says so', async () => {
    const { plan, lines } = bench([])
    expect(await ruleMatches({ name: 'r', when: [{ kind: 'missing' }] }, plan)).toBe(false)
    expect(lines.join('\n')).toContain('missing')
  })

  it('holds for a rule with no conditions', async () => {
    const { plan } = bench([])
    expect(await ruleMatches({ name: 'r', when: [] }, plan)).toBe(true)
  })
})
