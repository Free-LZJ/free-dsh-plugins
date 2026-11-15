import { describe, expect, it } from 'vitest'
import { createControlNodes } from '../src/flow/control.ts'
import { parseFlowFile } from '../src/flow/parse.ts'
import { FlowNodeRegistry, NodeTypeConflict } from '../src/flow/registry.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../src/registry.ts'
import type { RuleVocabulary } from '../src/config.ts'

/** 只认 `from` 与 `header` 两种条件的词表。 */
const vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike> = {
  normalizeCondition(input) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    if (record['kind'] === 'from') return { kind: 'from' }
    if (record['kind'] === 'header') return { kind: 'header' }
    return undefined
  },
  normalizeAction(input) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } : undefined
  },
}

/** 带内置控制流节点的注册表。 */
function registry(): FlowNodeRegistry {
  const r = new FlowNodeRegistry()
  r.registerAll('core', createControlNodes())
  return r
}

const HEAD = 'version: 2\nconnector: mail\nflows:\n'

describe('parseFlowFile', () => {
  it('读出一张最小的图', () => {
    const source = `${HEAD}  - id: f1
    name: 邮件分诊
    nodes:
      - id: start
        type: switch
        out:
          - { to: done, when: [{ kind: from }] }
          - { to: done }
      - id: done
        type: end
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    expect(parsed.error).toBeUndefined()
    expect(parsed.flows).toHaveLength(1)
    const flow = parsed.flows[0]!
    expect(flow.id).toBe('f1')
    expect(flow.connector).toBe('mail')
    expect(flow.nodes.map(n => n.id)).toEqual(['start', 'done'])
    expect(flow.nodes[0]?.out).toHaveLength(2)
  })

  it('拒绝 version: 1 并指向迁移脚本', () => {
    const parsed = parseFlowFile('version: 1\nrules: []\n', registry(), vocabulary)
    expect(parsed.flows).toEqual([])
    expect(parsed.error?.message).toContain('migrate-rules-v2')
  })

  it('拒绝不认识的版本', () => {
    const parsed = parseFlowFile('version: 9\nflows: []\n', registry(), vocabulary)
    expect(parsed.error?.message).toContain('version: 2')
  })

  it('悬空边整张图拒绝', () => {
    const source = `${HEAD}  - id: f1
    nodes:
      - id: a
        type: end
        out: [{ to: nowhere }]
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    expect(parsed.flows).toEqual([])
    expect(parsed.dropped.join('\n')).toContain('不存在的节点')
  })

  it('环整张图拒绝', () => {
    const source = `${HEAD}  - id: f1
    nodes:
      - id: a
        type: end
        out: [{ to: b }]
      - id: b
        type: end
        out: [{ to: a }]
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    expect(parsed.flows).toEqual([])
    expect(parsed.dropped.join('\n')).toContain('有环')
  })

  it('未知 type 保留为禁用，不丢整图', () => {
    const source = `${HEAD}  - id: f1
    nodes:
      - id: a
        type: no-such-node
      - id: b
        type: end
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    expect(parsed.error).toBeUndefined()
    const node = parsed.flows[0]?.nodes.find(n => n.id === 'a')
    expect(node?.enabled).toBe(false)
    expect(parsed.dropped.join('\n')).toContain('没有注册')
  })

  it('节点 id 重复时保留前一个', () => {
    const source = `${HEAD}  - id: f1
    nodes:
      - id: dup
        type: end
      - id: dup
        type: start
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    expect(parsed.flows[0]?.nodes).toHaveLength(1)
    expect(parsed.flows[0]?.nodes[0]?.type).toBe('end')
    expect(parsed.dropped.join('\n')).toContain('重复')
  })

  it('没有 connector 的图永远不执行，直接跳过', () => {
    const parsed = parseFlowFile('version: 2\nflows:\n  - id: f1\n    nodes:\n      - { id: a, type: end }\n', registry(), vocabulary)
    expect(parsed.flows).toEqual([])
    expect(parsed.dropped.join('\n')).toContain('connector')
  })

  it('读得出 pos，非法 pos 忽略', () => {
    const source = `${HEAD}  - id: f1
    nodes:
      - id: a
        type: end
        pos: { x: 10, y: 20 }
      - id: b
        type: end
        pos: { x: "left", y: 20 }
`
    const parsed = parseFlowFile(source, registry(), vocabulary)
    const [a, b] = parsed.flows[0]!.nodes
    expect(a?.pos).toEqual({ x: 10, y: 20 })
    expect(b?.pos).toBeUndefined()
  })
})

describe('FlowNodeRegistry', () => {
  it('重名注册直接拒绝', () => {
    const r = registry()
    expect(() => r.register('mail', { type: 'switch', label: 'x', group: 'control', run: async () => ({ ok: true, detail: '' }) }))
      .toThrow(NodeTypeConflict)
  })

  it('同一 owner 重复注册是幂等的', () => {
    const r = registry()
    const node = { type: 'mine', label: 'x', group: 'action' as const, run: async () => ({ ok: true as const, detail: '' }) }
    r.register('mail', node)
    expect(() => r.register('mail', node)).not.toThrow()
    expect(r.get('mine')).toBeDefined()
  })

  it('批量注册中途冲突时整块回退', () => {
    const r = registry()
    const nodes = [
      { type: 'fresh', label: 'a', group: 'action' as const, run: async () => ({ ok: true as const, detail: '' }) },
      { type: 'switch', label: 'b', group: 'control' as const, run: async () => ({ ok: true as const, detail: '' }) },
    ]
    expect(() => r.registerAll('mail', nodes)).toThrow(NodeTypeConflict)
    expect(r.get('fresh')).toBeUndefined()
  })
})
