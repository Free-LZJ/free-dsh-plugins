/**
 * 真规则 + 真词表 + BPMN 执行器。
 *
 * 前面的测试各自守着一段：`task.spec.ts` 用假词表验核心，`bpmn.spec.ts` 验编译与执行。
 * 这里把三者接起来——**拿发货默认规则 `basic.yml` 本身**（不是测试里手写的几条），
 * 用 mail 的真实条件实现判定，交给 BPMN 执行器路由，看走的分支与动作是不是那一棵
 * 「邮件触发 → 各条规则 → 各自的动作」的树。
 *
 * 只挑确定性规则：`classifier` 规则依赖模型判定，属于另一条路径（分类节点），这里不测。
 *
 * @module @free-lzj/dsh-mail/tests/triage/pipeline
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileRules, parseRuleFile, ruleMatches, runFlow, type FlowActionOutcome } from '@free-lzj/dsh-decision'
import { builtinConditions } from '../../src/triage/conditions.ts'
import { MAIL_VOCABULARY } from '../../src/triage/config.ts'
import type { MailSummaryLike } from '../../src/triage/types.ts'

/**
 * DSH 连接器那六个动作的收窄桩。
 *
 * 真实运行时这一段由 `@free-lzj/dsh-connector-dsh` 的 `normalizeDshAction` 提供，任务引擎
 * 把各连接器的词表**按顺序并起来**（见 `engine.combinedVocabulary`）——邮件词表只认自己
 * 那四个动作，问不到就轮到下一个连接器。这里内联一份等价桩，是为了让这份测试不用把
 * mail 依赖到 connector-dsh 上。
 * @param input - 规则文件里的一个动作。
 * @returns 收窄后的动作，或 undefined（不认识）。
 */
function normalizeDshAction(input: unknown): { kind: string } | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const kind = record['kind']
  if (typeof kind !== 'string') return undefined
  return ['notify', 'session', 'followup', 'script', 'mcp', 'http'].includes(kind) ? { kind } : undefined
}

/** 与任务引擎同样的合并顺序：先邮件、再 DSH。 */
const vocabulary = {
  normalizeCondition: MAIL_VOCABULARY.normalizeCondition,
  normalizeAction: (input: unknown) => MAIL_VOCABULARY.normalizeAction(input) ?? normalizeDshAction(input),
  ...(MAIL_VOCABULARY.validate === undefined ? {} : { validate: MAIL_VOCABULARY.validate }),
}

const source = readFileSync(new URL('../../defaults/basic.yml', import.meta.url), 'utf8')

const parsed = parseRuleFile(source, vocabulary, 'mail')
if (!parsed.ok) throw new Error(`发货默认规则解析失败：${parsed.error.message}`)

/** 只保留确定性规则：分类规则要模型判定，走的是另一条路。 */
const rules = parsed.rules
  .filter(rule => rule.enabled)
  .filter(rule => rule.when.every(condition => condition.kind !== 'classifier'))

const conditions = new Map(builtinConditions().map(condition => [condition.kind, condition]))

/** 造一封摘要。 */
function mail(overrides: Partial<MailSummaryLike> = {}): MailSummaryLike {
  return {
    accountId: 'acc',
    folder: 'INBOX',
    uid: 7,
    uidValidity: 3,
    subject: 'Run failed: E2E',
    from: { address: 'notifications@github.com', name: 'GitHub' },
    date: '2026-11-13T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: 'workflow failed',
    headers: {},
    ...overrides,
  }
}

/**
 * 跑一封邮件穿过整条链。
 * @param summary - 这封邮件。
 * @returns 命中的规则与执行过的动作。
 */
async function triage(summary: MailSummaryLike): Promise<{
  readonly rule: string | undefined
  readonly actions: readonly string[]
  readonly status: string
}> {
  const flow = compileRules(rules)
  const executed: string[] = []
  const summaryOut = await runFlow(flow, {
    judge: async (ruleId) => {
      const rule = rules.find(candidate => candidate.id === ruleId)
      if (rule === undefined) return false
      return await ruleMatches(rule, {
        conditions: { get: kind => conditions.get(kind) },
        context: () => ({ summary, accountName: 'acc' }) as never,
        readBody: async () => '',
        log: () => {},
      })
    },
    runAction: async (ruleId, index): Promise<FlowActionOutcome> => {
      const rule = rules.find(candidate => candidate.id === ruleId)
      const spec = rule?.then[index]
      executed.push(`${ruleId}#${spec?.kind ?? '?'}`)
      return { ok: true, detail: `${spec?.kind ?? '?'} 完成` }
    },
    record: () => {},
  })
  return { rule: summaryOut.matchedRuleId, actions: executed, status: summaryOut.status }
}

describe('发货默认规则在 BPMN 执行器上的走向', () => {
  it('编译后没有规则被丢弃', () => {
    const flow = compileRules(rules)
    expect(flow.dropped).toEqual([])
    expect(flow.order).toEqual(rules.map(rule => rule.id))
  })

  it('GitHub 通知走 github 规则，动作是开会话 + 通知', async () => {
    const result = await triage(mail({ from: { address: 'notifications@github.com' } }))
    expect(result.rule).toBe('github')
    expect(result.actions).toEqual(['github#session', 'github#notify'])
  })

  it('安全发件人走 security 规则，只提醒', async () => {
    const result = await triage(mail({ from: { address: 'no-reply@accounts.google.com' }, subject: '新登录' }))
    expect(result.rule).toBe('security')
    expect(result.actions).toEqual(['security#notify'])
  })

  it('带退订头走 promo 规则，先标已读再移动', async () => {
    const result = await triage(mail({
      from: { address: 'news@shop.example' },
      subject: '本周促销',
      headers: { 'list-unsubscribe': '<mailto:u@example>' },
    }))
    expect(result.rule).toBe('promo')
    expect(result.actions).toEqual(['promo#markRead', 'promo#move'])
  })

  it('不认识的邮件不命中任何确定性规则', async () => {
    const result = await triage(mail({ from: { address: 'friend@example.com' }, subject: '在吗' }))
    expect(result.rule).toBeUndefined()
    expect(result.actions).toEqual([])
    expect(result.status).toBe('skipped')
  })
})
