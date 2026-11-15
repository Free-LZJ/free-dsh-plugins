import { describe, expect, it } from 'vitest'
import { compileRules, hitVariable, runFlow, type FlowActionOutcome, type FlowNodeRecord } from '../src/bpmn/index.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../src/registry.ts'
import type { Rule } from '../src/types.ts'

type TestRule = Rule<ConditionSpecLike, ActionSpecLike>

function rule(id: string, priority: number, actions: readonly string[], extra: Partial<TestRule> = {}): TestRule {
  return {
    id,
    name: id,
    enabled: true,
    priority,
    when: [{ kind: 'from' }],
    then: actions.map(kind => ({ kind })),
    ...extra,
  }
}

describe('compileRules', () => {
  it('按规则顺序编成一串网关，最后接 rest', () => {
    const flow = compileRules([rule('github', 10, ['session', 'notify']), rule('jira', 20, ['notify'])])
    expect(flow.order).toEqual(['github', 'jira'])
    expect(flow.xml).toContain('id="gw_r0"')
    expect(flow.xml).toContain('id="act_r0_0"')
    expect(flow.xml).toContain('id="act_r0_1"')
    expect(flow.xml).toContain('id="gw_r1"')
    // 首条的 else 接到下一条网关，末条的 else 接到 rest。
    expect(flow.xml).toContain('id="else_r0" sourceRef="gw_r0" targetRef="gw_r1"')
    expect(flow.xml).toContain('id="else_r1" sourceRef="gw_r1" targetRef="rest"')
    // 命中条件读的是这条规则自己的标志位。
    expect(flow.xml).toContain(`\${environment.variables.${hitVariable(0)}}`)
    // 流程里没有判定节点：判定在跑之前就做完了。
    expect(flow.xml).not.toContain('judge_')
  })

  it('丢弃空 then，并说明原因', () => {
    const flow = compileRules([
      rule('a', 10, ['notify'], { stopOnMatch: false }),
      rule('b', 20, []),
      rule('c', 30, ['notify']),
    ])
    expect(flow.order).toEqual(['a', 'c'])
    expect(flow.continues).toEqual([0])
    expect(flow.dropped).toHaveLength(1)
    expect(flow.dropped.join('\n')).toContain('没有任何动作')
  })

  it('stopOnMatch: false 的规则命中后把 token 交给下一条网关，没有自己的收尾', () => {
    const flow = compileRules([
      rule('a', 10, ['notify'], { stopOnMatch: false }),
      rule('b', 20, ['notify']),
    ])
    expect(flow.continues).toEqual([0])
    expect(flow.xml).toContain('id="fin_r0" sourceRef="act_r0_0" targetRef="gw_r1"')
    expect(flow.xml).not.toContain('id="end_r0"')
    expect(flow.xml).toContain('id="end_r1"')
  })

  it('没有规则时流程只有 start 与 rest', () => {
    const flow = compileRules([])
    expect(flow.order).toEqual([])
    expect(flow.steps.size).toBe(0)
    expect(flow.xml).toContain('<startEvent id="start"')
    expect(flow.xml).toContain('<endEvent id="rest"')
  })
})

describe('runFlow', () => {
  const rules = [rule('github', 10, ['session', 'notify']), rule('jira', 20, ['notify'])]

  /** 造一份记录器、判定表与动作表。 */
  function harness(hit: string | undefined, failOn?: string) {
    const records: FlowNodeRecord[] = []
    const ran: string[] = []
    return {
      records,
      ran,
      deps: {
        judge: async (ruleId: string) => ruleId === hit,
        runAction: async (ruleId: string, index: number): Promise<FlowActionOutcome> => {
          const name = `${ruleId}#${String(index)}`
          ran.push(name)
          if (name === failOn) return { ok: false, detail: '炸了', failure: 'transient' }
          return { ok: true, detail: `做了 ${name}` }
        },
        record: (node: FlowNodeRecord) => { records.push(node) },
      },
    }
  }

  it('只跑命中那条规则的动作', async () => {
    const flow = compileRules(rules)
    const h = harness('github')
    const summary = await runFlow(flow, h.deps)
    expect(summary.matchedRuleId).toBe('github')
    expect(summary.status).toBe('done')
    expect(h.ran).toEqual(['github#0', 'github#1'])
    // 一条命中记录 + 两个动作记录。
    expect(h.records.map(r => r.kind)).toEqual(['rule', 'action', 'action'])
    expect(h.records[0]?.detail).toContain('github')
  })

  it('第一条不中时落到第二条', async () => {
    const flow = compileRules(rules)
    const h = harness('jira')
    const summary = await runFlow(flow, h.deps)
    expect(summary.matchedRuleId).toBe('jira')
    expect(h.ran).toEqual(['jira#0'])
    expect(h.records.map(r => r.kind)).toEqual(['rule', 'action'])
  })

  it('一条都不中时 skipped，且没有动作发生', async () => {
    const flow = compileRules(rules)
    const h = harness(undefined)
    const summary = await runFlow(flow, h.deps)
    expect(summary.status).toBe('skipped')
    expect(summary.matchedRuleId).toBeUndefined()
    expect(h.ran).toEqual([])
    expect(h.records).toEqual([])
  })

  it('动作失败时整条记为 partial，后面的动作仍然跑', async () => {
    const flow = compileRules(rules)
    const h = harness('github', 'github#0')
    const summary = await runFlow(flow, h.deps)
    expect(summary.status).toBe('partial')
    expect(h.ran).toEqual(['github#0', 'github#1'])
  })
})
