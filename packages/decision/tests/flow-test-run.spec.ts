/**
 * 图模式的试跑：喂给连接器的是**分支边**，不是空的规则表。
 *
 * 回归点（实测撞到的）：`engine.test()` 直接把 `currentRules` 交给连接器，而图模式下
 * `currentRules` 恒为空——于是「试跑」对一封明明会被流程图分走的邮件，永远回答
 * 「没有规则命中 · 这封邮件会被留在面板里，不产生任何动作」。答案不是错的细节，是反的。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-test-run
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { Rule } from '../src/types.ts'

const vocabulary = {
  normalizeCondition(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { ...record, kind: record['kind'] } as never : undefined
  },
  normalizeAction(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } as never : undefined
  },
}

/** 一个会记下「试跑时收到了哪些规则」的假连接器。 */
function connector(seen: { rules: readonly Rule<never, never>[] }[]): TaskConnector {
  return {
    id: 'fake',
    label: '假连接器',
    directions: ['in'],
    implemented: true,
    triggers: [{
      kind: 'trigger',
      id: 'fake:new',
      connector: 'fake',
      listensTo: ['fake.new'],
      async run() {
        return { status: 'continue', ok: true, detail: '收到' }
      },
    }],
    actions: [],
    nodes: [],
    judge: {
      conditions: { get: () => undefined },
      plan: () => ({ context: () => ({}), readBody: async () => '' }),
    } as never,
    vocabulary: vocabulary as never,
    defaultRules: '',
    decisionConfig: () => ({
      enabled: true,
      dryRun: false,
      undoWindowSeconds: 0,
      runHistoryLimit: 500,
      runRetentionDays: 30,
    }),
    async test(_ref: never, rules: readonly Rule<never, never>[]) {
      seen.push({ rules })
      return { ok: true, result: { ruleId: rules[0]?.id ?? '(none)', ruleName: rules[0]?.name ?? '没有规则命中', actions: [], reason: '', attempts: [] } }
    },
  } as never
}

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-flow-test-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'demo.yml'), [
    'id: demo',
    'trigger: fake:new',
    'connector: fake',
    'nodes:',
    '  - id: trigger',
    '    type: trigger',
    '    config: { event: fake.new }',
    '    out: [{ to: route }]',
    '  - id: route',
    '    type: switch',
    '    out:',
    '      - to: call-a',
    '        when:',
    '          - kind: from',
    '            any:',
    '              - x@example.com',
    '      - to: end',
    '  - id: call-a',
    '    type: mark',
    '    out: [{ to: end }]',
    '  - id: end',
    '    type: end',
    '',
  ].join('\n'), 'utf8')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch { /* 临时目录，删不掉就算了 */ }
})

describe('图模式下的试跑', () => {
  it('交给连接器的是分支边，不是空的规则表', async () => {
    const seen: { rules: readonly Rule<never, never>[] }[] = []
    const engine = new TaskEngine({ home })
    engine.register(connector(seen))
    await engine.start()

    const answer = await engine.test({ accountId: 'a', folder: 'INBOX', uid: 1 })
    expect(answer.ok).toBe(true)
    expect(seen).toHaveLength(1)
    // 两条出边 → 两条「临时规则」；以前这里是空的，于是试跑永远说「没有规则命中」。
    const rules = seen[0]!.rules
    expect(rules.map(rule => rule.id)).toEqual(['route->call-a#0', 'route->end#1'])
    // 兜底那条的 when 是空的（= 匹配一切），这正是它在图里的意思。
    expect(rules[1]!.when).toEqual([])
    expect(rules[0]!.when).toEqual([{ kind: 'from', any: ['x@example.com'] }])
    // 试跑不执行动作。
    expect(rules.every(rule => rule.then.length === 0)).toBe(true)
    engine.stop()
  })

  it('没有分支的图不编造规则', async () => {
    const seen: { rules: readonly Rule<never, never>[] }[] = []
    writeFileSync(join(home, 'events', 'demo.yml'), [
      'id: demo',
      'trigger: fake:new',
      'connector: fake',
      'nodes:',
      '  - id: trigger',
      '    type: trigger',
      '    config: { event: fake.new }',
      '    out: [{ to: end }]',
      '  - id: end',
      '    type: end',
      '',
    ].join('\n'), 'utf8')
    const engine = new TaskEngine({ home })
    engine.register(connector(seen))
    await engine.start()
    await engine.test({ accountId: 'a', folder: 'INBOX', uid: 1 })
    expect(seen[0]!.rules).toEqual([])
    engine.stop()
  })
})
