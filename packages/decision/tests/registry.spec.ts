/**
 * 注册表：按 kind 注册与取出，重复注册覆盖。
 *
 * 这些断言守住的是「装配处只注册、不分支」这条结构：如果注册表开始认识某个具体
 * 实现，这里的用例不会红，但 `rules/design-patterns.md` 的机械检查会；所以它们
 * 只钉行为（存了什么、取到什么、重名怎么办）。
 *
 * @module @free-lzj/dsh-decision/tests/registry
 */

import { describe, expect, it } from 'vitest'
import {
  ActionRegistry, ConditionRegistry, fillTemplate, registerAll,
  type Action, type Condition,
} from '../src/registry.ts'

/** 一个最小条件：配置里只有一个 `any` 列表。 */
interface Spec {
  readonly kind: string
  readonly any?: readonly string[]
}

/** 一个最小条件实现。 */
interface MiniCondition extends Condition<Spec, { readonly body: string }, 'needle' | 'always'> {
  readonly kind: 'needle' | 'always'
}

/** 一个最小动作实现。 */
interface MiniAction extends Action<Spec, { readonly body: string }, { readonly ok: boolean }, 'say'> {
  readonly kind: 'say'
}

const needle: MiniCondition = {
  kind: 'needle',
  needsBody: true,
  test: (spec, context) => (spec.any ?? []).some(one => context.body.includes(one)),
}

const always: MiniCondition = {
  kind: 'always',
  needsBody: false,
  test: () => true,
}

describe('ConditionRegistry', () => {
  it('answers the implementation it was given', () => {
    const registry = new ConditionRegistry<Spec, { readonly body: string }, 'needle' | 'always'>()
    registerAll(registry, [needle, always])
    expect(registry.get('needle')).toBe(needle)
    expect(registry.get('always')).toBe(always)
    expect(registry.kinds()).toEqual(['needle', 'always'])
  })

  it('answers undefined for a kind this deployment did not register', () => {
    const registry = new ConditionRegistry<Spec, { readonly body: string }, 'needle' | 'always'>()
    expect(registry.get('needle')).toBeUndefined()
  })

  it('replaces an implementation registered twice under the same kind', () => {
    const registry = new ConditionRegistry<Spec, { readonly body: string }, 'needle' | 'always'>()
    const replacement: MiniCondition = { kind: 'always', needsBody: true, test: () => false }
    registry.register(always)
    registry.register(replacement)
    expect(registry.get('always')).toBe(replacement)
    expect(registry.kinds()).toEqual(['always'])
  })
})

describe('ActionRegistry', () => {
  it('answers the action it was given, and only that one', () => {
    const registry = new ActionRegistry<Spec, { readonly body: string }, { readonly ok: boolean }, 'say'>()
    const say: MiniAction = {
      kind: 'say',
      sideEffect: false,
      run: async () => ({ ok: true }),
    }
    registry.register(say)
    expect(registry.get('say')).toBe(say)
    expect(registry.kinds()).toEqual(['say'])
  })
})

describe('registerAll', () => {
  it('registers every item and keeps their order', () => {
    const registry = new ConditionRegistry<Spec, { readonly body: string }, 'needle' | 'always'>()
    registerAll<MiniCondition>(registry, [needle, always])
    expect(registry.kinds()).toEqual(['needle', 'always'])
  })
})
describe('fillTemplate', () => {
  it('fills the names it was given, and blanks the rest', () => {
    // 模板里写错一个名字，不该让一个本来能跑的动作失败。
    expect(fillTemplate('{subject} · {missing}', { subject: '限时优惠' })).toBe('限时优惠 · ')
  })

  it('leaves plain text alone', () => {
    expect(fillTemplate('日常汇总', { subject: 'x' })).toBe('日常汇总')
  })

  it('blanks every name when there is no projection at all', () => {
    expect(fillTemplate('{a}-{b}', undefined)).toBe('-')
  })
})