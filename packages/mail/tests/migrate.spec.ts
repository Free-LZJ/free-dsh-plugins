/**
 * 迁移的闭环验证：真规则 → 图 → 序列化 → 再解析。
 *
 * 光看转换结果对不对不够：写出去的 YAML 必须能被解析器**原样读回来**，否则迁移脚本
 * 只是生成了一份好看但跑不了的文件。这里把那一圈走完。
 *
 * @module @free-lzj/dsh-mail/tests/migrate
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FlowNodeRegistry, createControlNodes, migrateRulesToFlow, parseFlowFile, parseRuleFile, stringifyFlowFile } from '@free-lzj/dsh-decision'
import { builtinConditions } from '../src/triage/conditions.ts'
import { MAIL_VOCABULARY } from '../src/triage/config.ts'
import { createMailFlowNodes } from '../src/nodes.ts'
import type { MailConnectorDeps, MailOpsLike } from '../src/connector.ts'
import type { ActionSpecLike, ConditionSpecLike, Rule } from '@free-lzj/dsh-decision'

/** 迁移接受的那种规则。 */
type MigratableRule = Rule<ConditionSpecLike, ActionSpecLike>

/** DSH 连接器认的六个动作。 */
const DSH_ACTIONS = new Set(['notify', 'session', 'followup', 'script', 'mcp', 'http'])

/** 合并词表：先邮件，再 DSH。与运行时 `combinedVocabulary` 同序。 */
const vocabulary = {
  normalizeCondition: MAIL_VOCABULARY.normalizeCondition,
  normalizeAction: (input: unknown) => MAIL_VOCABULARY.normalizeAction(input) ?? normalizeDsh(input),
  ...(MAIL_VOCABULARY.validate === undefined ? {} : { validate: MAIL_VOCABULARY.validate }),
}

/** DSH 动作的最小收窄。 */
function normalizeDsh(input: unknown): { kind: string } | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const kind = (input as Record<string, unknown>)['kind']
  return typeof kind === 'string' && DSH_ACTIONS.has(kind) ? { kind } : undefined
}

/** 一个不碰邮箱的 ops。 */
const ops: MailOpsLike = {
  fetchDetail: async () => undefined,
  listMailboxes: async () => [],
  ensureFolder: async (_accountId, path) => ({ ok: true, path }),
  applyAction: async () => ({ ok: true }),
}

/** 只为了拿到节点类型清单，不真跑。 */
const deps: MailConnectorDeps = {
  mail: ops,
  config: () => ({ model: '' }) as never,
  log: () => {},
  warn: () => {},
}

/** 注册表：内置控制流 + 邮件节点 + 迁移后会用到的动作名。 */
function registry(): FlowNodeRegistry {
  const r = new FlowNodeRegistry()
  r.registerAll('core', createControlNodes())
  r.registerAll('mail', createMailFlowNodes(deps))
  // 邮件域那四个动作与 DSH 的六个动作在节点图里还没有专属实现：它们仍是旧
  // `ActionNode`，运行时由 `Engine.registerNodes` 通过 `actionsToFlowNodes` 适配进来。
  // 这里只关心结构，用占位类型占住名字。
  for (const type of ['markRead', 'flag', 'move', 'archive', ...DSH_ACTIONS]) {
    r.register('mail', {
      type,
      label: type,
      group: 'action',
      sideEffect: true,
      async run() { return { ok: true, detail: type } },
    })
  }
  return r
}

const source = readFileSync(new URL('../defaults/basic.yml', import.meta.url), 'utf8')

describe('发货默认规则的迁移闭环', () => {
  const parsed = parseRuleFile(source, vocabulary as never, 'mail')
  /** 解析结果按迁移要的形状看。 */
  const rules = (parsed.ok ? parsed.rules : []) as readonly MigratableRule[]
  if (!parsed.ok) throw new Error(`解析默认规则失败：${parsed.error.message}`)

  it('转换后 0 条被解析期丢弃', () => {
    expect(parsed.dropped).toEqual([])
  })

  it('转成图，序列化，再解析仍然 0 错误', () => {
    const flow = migrateRulesToFlow(rules.filter(rule => rule.enabled), {
      connector: 'mail',
      flowId: 'mail-triage',
      flowName: '邮件分诊',
    })
    const text = stringifyFlowFile([flow], { connector: 'mail' })
    const back = parseFlowFile(text, registry(), vocabulary as never)
    expect(back.error).toBeUndefined()
    expect(back.flows).toHaveLength(1)
    expect(back.flows[0]?.nodes.length).toBe(flow.nodes.length)
    expect(back.dropped).toEqual([])
  })

  it('每个动作 kind 都能在注册表里找到', () => {
    const flow = migrateRulesToFlow(rules.filter(rule => rule.enabled), { connector: 'mail' })
    const known = new Set(registry().list().map(node => node.type))
    const unknown = flow.nodes.map(node => node.type).filter(type => !known.has(type))
    expect(unknown).toEqual([])
  })

  it('classify 节点带上了全部标签的并集', () => {
    const flow = migrateRulesToFlow(rules.filter(rule => rule.enabled), { connector: 'mail' })
    const classify = flow.nodes.find(node => node.type === 'classify')
    const labels = (classify?.config as { labels?: readonly string[] } | undefined)?.labels ?? []
    expect(labels.length).toBeGreaterThan(0)
    // 默认规则里每个 classifier 条件声明过的标签都应该在。
    const declared = new Set<string>()
    for (const rule of rules) {
      for (const condition of rule.when) {
        if (condition.kind !== 'classifier') continue
        for (const label of (condition as { labels?: readonly string[] }).labels ?? []) declared.add(label)
      }
    }
    expect([...declared].every(label => labels.includes(label))).toBe(true)
  })

  it('邮件条件实现齐备（迁移不改条件语义）', () => {
    const kinds = builtinConditions().map(condition => condition.kind)
    for (const kind of ['from', 'to', 'subject', 'body', 'header', 'regex', 'attachment', 'classifier']) {
      expect(kinds).toContain(kind)
    }
  })
})
