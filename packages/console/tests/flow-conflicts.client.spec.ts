/**
 * 规则冲突检测的单测：同维度重叠、兜底后面的边不可达、不同维度不算冲突。
 *
 * @module @free-dsh-plugins/dsh-console/tests/flow-conflicts
 */

import { describe, expect, it } from 'vitest'
import { detectConflicts } from '../src/client/flow-conflicts.ts'
import type { TriageFlow } from '../src/client/rules.tsx'

/** 拼一张图：一个 switch + 若干出边。 */
function flowWith(outs: readonly { to: string; when?: readonly Record<string, unknown>[] }[]): TriageFlow {
  return {
    id: 'demo',
    name: '演示',
    connector: 'mail',
    trigger: 'mail:new',
    nodes: [
      { id: 'branch', type: 'switch', out: outs },
      ...outs.map(item => ({ id: item.to, type: 'workflow', config: { workflow: item.to } })),
    ],
  } as unknown as TriageFlow
}

describe('规则冲突检测', () => {
  it('同一个发件人被两条规则认领 → 报重叠', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['boss@corp.com', 'hr@corp.com'] }] },
      { to: 'b', when: [{ kind: 'from', any: ['hr@corp.com'] }] },
    ]))
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('overlap')
    expect(found[0]?.reason).toContain('from')
  })

  it('同一个标签被两条规则认领 → 报重叠', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'classifier', labels: ['todo'] }] },
      { to: 'b', when: [{ kind: 'classifier', labels: ['todo', 'dev'] }] },
    ]))
    expect(found).toHaveLength(1)
  })

  it('不同维度不算冲突（from 与 classifier 本来就该配合）', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['x@y.z'] }] },
      { to: 'b', when: [{ kind: 'classifier', labels: ['todo'] }] },
    ]))
    expect(found).toHaveLength(0)
  })

  it('无条件兜底后面的边不可达', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['x@y.z'] }] },
      { to: 'b' },
      { to: 'c', when: [{ kind: 'classifier', labels: ['todo'] }] },
    ]))
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('unreachable')
    expect(found[0]?.reason).toContain('永远不会命中')
  })

  it('兜底放最后是正常的，不报', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['x@y.z'] }] },
      { to: 'b' },
    ]))
    expect(found).toHaveLength(0)
  })

  it('发件人列表不重叠就不报', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['x@y.z'] }] },
      { to: 'b', when: [{ kind: 'from', any: ['p@q.r'] }] },
    ]))
    expect(found).toHaveLength(0)
  })
  it('from 相同但标签不同 → 不算冲突（整组条件是且）', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['gh@x.com'] }, { kind: 'classifier', labels: ['github-do'] }] },
      { to: 'b', when: [{ kind: 'from', any: ['gh@x.com'] }, { kind: 'classifier', labels: ['github-watch'] }] },
    ]))
    expect(found).toHaveLength(0)
  })

  it('from 与标签都重叠 → 才报冲突', () => {
    const found = detectConflicts(flowWith([
      { to: 'a', when: [{ kind: 'from', any: ['gh@x.com'] }, { kind: 'classifier', labels: ['todo'] }] },
      { to: 'b', when: [{ kind: 'from', any: ['gh@x.com'] }, { kind: 'classifier', labels: ['todo'] }] },
    ]))
    expect(found).toHaveLength(1)
  })
})
