import { describe, expect, it } from 'vitest'
import { migrateRuleToFlow } from '../src/flow/migrate.ts'
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

/** 图里的边是否都指向存在的节点。 */
function edgesResolve(nodes: readonly { id: string; out?: readonly { to: string }[] }[]): boolean {
  const ids = new Set(nodes.map(node => node.id))
  return nodes.every(node => (node.out ?? []).every(edge => ids.has(edge.to)))
}

describe('migrateRuleToFlow（一规则一图）', () => {
  it('一条规则拆成 trigger → branch → 动作… → end', () => {
    const flow = migrateRuleToFlow(
      rule('github', [{ kind: 'c:from' }], [{ kind: 'markRead' }, { kind: 'notify' }]),
      { connector: 'mail' },
    )
    expect(flow.id).toBe('github')
    expect(flow.connector).toBe('mail')
    const ids = flow.nodes.map(node => node.id)
    expect(ids).toEqual(['trigger', 'github__0', 'github__1', 'branch', 'end-hit', 'end-miss'])
    expect(edgesResolve(flow.nodes)).toBe(true)
  })

  it('触发器和 branch 都接得上，条件挂在命中那条边上', () => {
    const flow = migrateRuleToFlow(rule('r', [{ kind: 'c:from' }], [{ kind: 'markRead' }]), { connector: 'mail' })
    const trigger = flow.nodes.find(node => node.id === 'trigger')
    expect(trigger?.type).toBe('trigger')
    expect(trigger?.out?.[0]?.to).toBe('branch')

    const branch = flow.nodes.find(node => node.id === 'branch')
    expect(branch?.type).toBe('switch')
    // 第一条出边带条件，第二条是无条件兜底。
    expect(branch?.out?.[0]?.when).toHaveLength(1)
    expect(branch?.out?.[1]?.when).toBeUndefined()
  })

  it('没有条件的规则，命中边也不带 when', () => {
    const flow = migrateRuleToFlow(rule('r', [], [{ kind: 'markRead' }]), { connector: 'mail' })
    const branch = flow.nodes.find(node => node.id === 'branch')
    expect(branch?.out?.[0]?.when).toBeUndefined()
  })

  it('没有动作的规则：命中直接落到收尾', () => {
    const flow = migrateRuleToFlow(rule('r', [{ kind: 'c:from' }], []), { connector: 'mail' })
    const branch = flow.nodes.find(node => node.id === 'branch')
    expect(branch?.out?.[0]?.to).toBe('end-hit')
    expect(edgesResolve(flow.nodes)).toBe(true)
  })

  it('事件名可以覆盖，名字默认取规则名', () => {
    const flow = migrateRuleToFlow(rule('r', [], [{ kind: 'markRead' }]), { connector: 'webhook', event: 'http.called' })
    expect(flow.name).toBe('r')
    expect(flow.nodes.find(node => node.id === 'trigger')?.config).toEqual({ event: 'http.called' })
  })

  it('动作的配置原样带过去', () => {
    const flow = migrateRuleToFlow(
      rule('r', [], [{ kind: 'move', delaySeconds: 3 }]),
      { connector: 'mail' },
    )
    expect(flow.nodes.find(node => node.id === 'r__0')?.config).toMatchObject({ kind: 'move', delaySeconds: 3 })
  })
})
