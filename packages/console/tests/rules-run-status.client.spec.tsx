// @vitest-environment jsdom
/**
 * 执行记录里「状态」和「哪条规则」这两列。
 *
 * 回归点（实测撞到的，两条都是**看起来正常其实在骗人**）：
 *
 * 1. `runStatusKey` 只写了几个 case，`failed` 落到 default → 一次「执行器没有提供工作流
 *    能力」的失败，在记录里显示成**已跳过**：灰标签、跟真没轮到的长一模一样。
 * 2. 图模式下的执行没有 `rule` 那一格，`ruleName` 是空的 → 「规则」整列空白，而这一列
 *    正是这张表存在的意义。
 *
 * @module @free-dsh-plugins/dsh-console/tests/rules-run-status
 */

import { describe, expect, it } from 'vitest'
import { ruleLabelOf, runStatusKey, runTone } from '../src/client/rules.tsx'
import type { TriageRun } from '../src/client/rules.tsx'
import { en, zh } from '../src/client/locales.ts'

/** 一条只填了必要字段的执行记录。 */
function run(overrides: Partial<TriageRun> = {}): TriageRun {
  return {
    id: 'run-1',
    at: '2026-11-17T10:00:00.000Z',
    ruleId: '',
    ruleName: '',
    label: '',
    event: { from: 'x@example.com', subject: '一次执行', folder: '收件箱' },
    actions: [],
    status: 'done',
    ...overrides,
  } as TriageRun
}

describe('执行状态词', () => {
  it('失败就是失败，不许写成「已跳过」', () => {
    expect(runStatusKey('failed')).toBe('ruleRunFailed')
    expect(zh[runStatusKey('failed')]).toBe('已失败')
    // 这才是这次回归的核心：两者不能是同一句话。
    expect(zh[runStatusKey('failed')]).not.toBe(zh[runStatusKey('skipped')])
    expect(runTone('failed')).not.toBe(runTone('skipped'))
  })

  it('跑着的、等回信的，也各有自己的词', () => {
    expect(zh[runStatusKey('running')]).toBe('正在跑')
    expect(zh[runStatusKey('suspended')]).toBe('等回信')
    expect(zh[runStatusKey('done')]).toBe('已完成')
    expect(zh[runStatusKey('skipped')]).toBe('已跳过')
  })

  it('认不出的状态不冒充跳过', () => {
    expect(runStatusKey('whatever')).toBe('ruleRunUnknown')
    expect(zh[runStatusKey('whatever')]).not.toBe(zh[runStatusKey('skipped')])
  })

  it('中英两套都有这几个词', () => {
    for (const key of ['ruleRunFailed', 'ruleRunRunning', 'ruleRunSuspended', 'ruleRunUnknown'] as const) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
      expect(en[key]).not.toBe(zh[key])
    }
  })
})

describe('「哪条规则」这一列', () => {
  it('有名字就用名字', () => {
    expect(ruleLabelOf(run({ ruleName: 'Jira 缺陷转发' }))).toBe('Jira 缺陷转发')
  })

  it('图模式没有名字时，退回被调用的那条分支', () => {
    // 真实的图模式记录：没有 rule 那一格，只有一条 workflow 记录。
    expect(ruleLabelOf(run({
      nodes: [{ nodeId: 'call-promo', kind: 'workflow', ok: true, detail: '调用 promo' }],
    }))).toBe('调用 promo')
  })

  it('连描述都没有就用分支节点 id，绝不空着', () => {
    expect(ruleLabelOf(run({
      nodes: [{ nodeId: 'call-promo', kind: 'workflow', ok: true, detail: '' }],
    }))).toBe('call-promo')
  })
})
