/**
 * 改边：新增一条出边、拒绝重复、拒绝自连。
 *
 * 这是「新建规则」的最后一环——事件流里从 `分支` 拖一条线到子工作流节点。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-edge
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'

const vocabulary = {
  normalizeCondition(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { ...record, kind: record['kind'] } as never : undefined
  },
  normalizeAction(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } : undefined
  },
}

function connector(): TaskConnector {
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
        return { status: 'continue', ok: true, detail: '收到', seed: { key: 'fake:one', title: '一件事' } }
      },
    }],
    actions: [],
    nodes: [{
      type: 'mark',
      label: '标记',
      group: 'action',
      sideEffect: false,
      async run() {
        return { ok: true, detail: 'mark' }
      },
    }],
    judge: {
      conditions: { get: () => undefined } as never,
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
  }
}

/** 一张事件流：trigger → route(switch) → 两个 workflow 节点。 */
const FLOW = [
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
  '        when: [{ kind: from, any: [a@b.c] }]',
  '  - id: call-a',
  '    type: workflow',
  '    config: { workflow: wf-a }',
  '    out: [{ to: end }]',
  '  - id: call-b',
  '    type: workflow',
  '    config: { workflow: wf-b }',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-flow-edge-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'demo.yml'), FLOW, 'utf8')
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return { engine, home }
}

/** 读事件流文件里某个节点的出边。 */
function edgesOf(home: string, nodeId: string): { to?: string; when?: unknown[] }[] {
  const text = readFileSync(join(home, 'events', 'demo.yml'), 'utf8')
  const source = text.split('- id: ' + nodeId)[1] ?? ''
  const block = source.split(/\n  - id: /)[0] ?? ''
  const out: { to?: string; when?: unknown[] }[] = []
  for (const line of block.split('\n')) {
    const match = /^\s+- to: (\S+)/.exec(line)
    if (match?.[1] !== undefined) out.push({ to: match[1] })
  }
  return out
}

describe('改边', () => {
  it('新增一条出边，带条件', async () => {
    const { engine, home } = await boot()
    const result = await engine.addFlowEdge({
      from: 'route',
      to: 'call-b',
      flowId: 'demo',
      when: [{ kind: 'from', any: ['x@y.z'] }],
    })
    expect(result.ok).toBe(true)
    const edges = edgesOf(home, 'route')
    expect(edges.some(edge => edge.to === 'call-b')).toBe(true)
    engine.stop()
  })

  it('已经连过的再连一次会被拒', async () => {
    const { engine } = await boot()
    await engine.addFlowEdge({ from: 'route', to: 'call-b', flowId: 'demo' })
    const again = await engine.addFlowEdge({ from: 'route', to: 'call-b', flowId: 'demo' })
    expect(again.ok).toBe(false)
    expect(again.message).toContain('已经连到')
    engine.stop()
  })

  it('不能连到自己', async () => {
    const { engine } = await boot()
    const result = await engine.addFlowEdge({ from: 'route', to: 'route', flowId: 'demo' })
    expect(result.ok).toBe(false)
    engine.stop()
  })

  it('目标不存在时拒绝', async () => {
    const { engine } = await boot()
    const result = await engine.addFlowEdge({ from: 'route', to: 'nope', flowId: 'demo' })
    expect(result.ok).toBe(false)
    engine.stop()
  })

  it('改一条已有边的指向', async () => {
    const { engine, home } = await boot()
    const result = await engine.relinkFlowEdge({ from: 'trigger', index: 0, to: 'call-b', flowId: 'demo' })
    expect(result.ok).toBe(true)
    expect(edgesOf(home, 'trigger')[0]?.to).toBe('call-b')
    engine.stop()
  })
})
