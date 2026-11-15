import { describe, expect, it } from 'vitest'
import { migrateRulesToFlow } from '../src/flow/migrate.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../src/registry.ts'
import type { Rule } from '../src/types.ts'

type TestRule = Rule<ConditionSpecLike, ActionSpecLike>

/** 一条规则。 */
function rule(
  id: string,
  when: readonly ConditionSpecLike[],
  actions: readonly ActionSpecLike[],
  extra: Partial<TestRule> = {},
): TestRule {
  return { id, name: id, enabled: true, priority: 0, when, then: actions, ...extra }
}

describe('migrateRulesToFlow', () => {
  it('每条规则一个 switch 分支，动作串成链', () => {
    const flow = migrateRulesToFlow([
      rule('a', [{ kind: 'from' }], [{ kind: 'markRead' }, { kind: 'notify' }]),
      rule('b', [{ kind: 'header' }], [{ kind: 'move' }]),
    ], { connector: 'mail' })

    const route = flow.nodes.find(node => node.id === 'route')
    expect(route?.out).toHaveLength(3) // 两条规则 + 兜底 rest
    expect(route?.out?.at(-1)?.to).toBe('rest')

    // a 的两个动作串联，末尾接自己的 end
    const a0 = flow.nodes.find(node => node.id === 'a__0')
    const a1 = flow.nodes.find(node => node.id === 'a__1')
    expect(a0?.type).toBe('markRead')
    expect(a0?.out?.[0]?.to).toBe('a__1')
    expect(a1?.type).toBe('notify')
    expect(a1?.out?.[0]?.to).toBe('a__end')
    expect(flow.nodes.some(node => node.id === 'a__end')).toBe(true)
  })

  it('classifier 条件收敛成一个 classify 节点，标签取并集', () => {
    const flow = migrateRulesToFlow([
      rule('x', [{ kind: 'classifier', labels: ['dev'] } as never], [{ kind: 'notify' }]),
      rule('y', [{ kind: 'classifier', labels: ['todo', 'dev'] } as never], [{ kind: 'notify' }]),
    ], { connector: 'mail' })

    const classify = flow.nodes.find(node => node.id === 'classify')
    expect(classify?.type).toBe('classify')
    const labels = (classify?.config as { labels?: readonly string[] } | undefined)?.labels
    expect(labels).toEqual(['dev', 'todo'])
    // start 先到 classify，再到 route
    const start = flow.nodes.find(node => node.id === 'start')
    expect(start?.out?.[0]?.to).toBe('classify')
    expect(classify?.out?.[0]?.to).toBe('route')
  })

  it('没有 classifier 条件时不建 classify 节点', () => {
    const flow = migrateRulesToFlow([rule('z', [{ kind: 'from' }], [{ kind: 'notify' }])], { connector: 'mail' })
    expect(flow.nodes.some(node => node.type === 'classify')).toBe(false)
    expect(flow.nodes.find(node => node.id === 'start')?.out?.[0]?.to).toBe('route')
  })

  it('空 when 的规则成为无条件兜底分支，排在兜底 rest 之前', () => {
    const flow = migrateRulesToFlow([
      rule('first', [{ kind: 'from' }], [{ kind: 'notify' }]),
      rule('catch-all', [], [{ kind: 'notify' }]),
    ], { connector: 'mail' })
    const route = flow.nodes.find(node => node.id === 'route')
    const targets = route?.out?.map(edge => edge.to)
    expect(targets).toEqual(['first__0', 'catch-all__0', 'rest'])
    // 只有 catch-all 那条没有 when
    expect(route?.out?.[1]?.when).toBeUndefined()
  })

  it('禁用与空 then 的规则被跳过', () => {
    const flow = migrateRulesToFlow([
      rule('off', [{ kind: 'from' }], [{ kind: 'notify' }], { enabled: false }),
      rule('empty', [{ kind: 'from' }], []),
      rule('keep', [{ kind: 'from' }], [{ kind: 'notify' }]),
    ], { connector: 'mail' })
    const route = flow.nodes.find(node => node.id === 'route')
    expect(route?.out?.map(edge => edge.to)).toEqual(['keep__0', 'rest'])
  })

  it('转换出来的图能被解析器读回（结构自洽）', () => {
    const flow = migrateRulesToFlow([rule('a', [{ kind: 'from' }], [{ kind: 'notify' }])], { connector: 'mail' })
    const ids = new Set(flow.nodes.map(node => node.id))
    for (const node of flow.nodes) {
      for (const edge of node.out ?? []) {
        expect(ids.has(edge.to)).toBe(true)
      }
    }
  })
})
