/**
 * 规则的结构归一化：哪些条目能活下来，为什么死的，以及优先级顺序。
 *
 * 这里用的是**假词表**（条件只认 `any`、动作只认 `folder`），因为内核这一层不该
 * 知道邮件的条件长什么样——这份文件要证明的正是「结构判断与词表无关」。
 *
 * @module @free-lzj/dsh-decision/tests/config
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DECISION_CONFIG, normalizeDecisionConfig, normalizeRules, type RuleVocabulary,
} from '../src/config.ts'

/** 测试用的条件配置。 */
interface Condition {
  readonly kind: string
  readonly any?: readonly string[]
}

/** 测试用的动作配置。 */
interface Action {
  readonly kind: string
  readonly folder?: string
}

/** 只认 `any` / `folder` 的假词表。 */
const vocabulary: RuleVocabulary<Condition, Action> = {
  normalizeCondition: (input) => {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as { kind?: unknown; any?: unknown }
    if (typeof record.kind !== 'string') return undefined
    if (!Array.isArray(record.any) || record.any.length === 0) return undefined
    return { kind: record.kind, any: record.any.map(String) }
  },
  normalizeAction: (input) => {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as { kind?: unknown; folder?: unknown }
    if (typeof record.kind !== 'string') return undefined
    if (record.folder !== undefined && typeof record.folder !== 'string') return undefined
    return { kind: record.kind, ...(record.folder === undefined ? {} : { folder: record.folder }) }
  },
}

/** 一条能通过的原始规则。 */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'GitHub 通知',
    when: [{ kind: 'from', any: ['github'] }],
    then: [{ kind: 'archive' }],
    ...overrides,
  }
}

describe('normalizeRules', () => {
  it('keeps order as priority when the file gives none', () => {
    const { rules, dropped } = normalizeRules(
      [raw({ name: 'first' }), raw({ name: 'second' })],
      vocabulary,
    )
    expect(dropped).toEqual([])
    expect(rules.map(rule => [rule.name, rule.priority])).toEqual([['first', 0], ['second', 10]])
  })

  it('sorts by the priority the file does give', () => {
    const { rules } = normalizeRules(
      [raw({ name: 'late', priority: 90 }), raw({ name: 'early', priority: 5 })],
      vocabulary,
    )
    expect(rules.map(rule => rule.name)).toEqual(['early', 'late'])
  })

  it('derives ids, and makes a duplicate one unique instead of dropping the rule', () => {
    const { rules, dropped } = normalizeRules(
      [raw({ id: 'same' }), raw({ id: 'same', name: 'second' })],
      vocabulary,
    )
    expect(rules.map(rule => rule.id)).toEqual(['same', 'same-2'])
    expect(dropped.some(entry => entry.includes('重复'))).toBe(true)
  })

  it('drops a rule with no name, a non-array when, or an empty then — and says which', () => {
    const { rules, dropped } = normalizeRules(
      [
        { when: [], then: [{ kind: 'archive' }] },
        raw({ name: 'broken when', when: { kind: 'from' } }),
        raw({ name: 'no actions', then: [] }),
      ],
      vocabulary,
    )
    expect(rules).toEqual([])
    expect(dropped).toHaveLength(3)
    expect(dropped[0]).toContain('缺少 name')
    expect(dropped[1]).toContain('when 必须是数组')
    expect(dropped[2]).toContain('then 是空的')
  })

  it('drops the whole rule when one condition or action is malformed', () => {
    const { rules, dropped } = normalizeRules(
      [
        raw({ name: 'bad condition', when: [{ kind: 'from' }] }),
        raw({ name: 'bad action', then: [{ kind: 'archive', folder: 5 }] }),
        raw({ name: 'fine' }),
      ],
      vocabulary,
    )
    expect(rules.map(rule => rule.name)).toEqual(['fine'])
    expect(dropped).toHaveLength(2)
  })

  it('refuses a top-level value that is not an array', () => {
    const { rules, dropped } = normalizeRules({ rules: [] }, vocabulary)
    expect(rules).toEqual([])
    expect(dropped[0]).toContain('顶层必须是一个数组')
  })

  it('keeps the optional label and stopOnMatch, and defaults enabled to true', () => {
    const { rules } = normalizeRules([raw({ label: '自定义', stopOnMatch: false, enabled: false })], vocabulary)
    expect(rules[0]).toMatchObject({ label: '自定义', stopOnMatch: false, enabled: false })
    expect(normalizeRules([raw()], vocabulary).rules[0]?.enabled).toBe(true)
  })
})

describe('normalizeDecisionConfig', () => {
  it('answers the documented defaults when nothing is given', () => {
    expect(normalizeDecisionConfig(undefined)).toEqual(DEFAULT_DECISION_CONFIG)
    expect(normalizeDecisionConfig({})).toEqual(DEFAULT_DECISION_CONFIG)
  })

  it('keeps a valid value and refuses an invalid one, field by field', () => {
    const config = normalizeDecisionConfig({
      enabled: false,
      dryRun: true,
      undoWindowSeconds: 30,
      // 超出上界：退回默认值，而不是把 0 秒当成合法值悄悄生效。
      runHistoryLimit: 10_000_000,
      runRetentionDays: 7,
    })
    expect(config).toMatchObject({ enabled: false, dryRun: true, undoWindowSeconds: 30, runRetentionDays: 7 })
    expect(config.runHistoryLimit).toBe(DEFAULT_DECISION_CONFIG.runHistoryLimit)
  })

  it('treats a non-object as empty rather than throwing', () => {
    expect(normalizeDecisionConfig('nonsense')).toEqual(DEFAULT_DECISION_CONFIG)
  })
})
