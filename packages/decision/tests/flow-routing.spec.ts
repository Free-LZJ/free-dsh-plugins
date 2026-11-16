/**
 * 端到端：事件 → 事件流 → switch 判定 → 子工作流。
 *
 * 这里要证明三件事，它们正是之前一直没验证过的：
 *
 * 1. **确定性条件命中时零模型调用**（`from` 对上了就别去问 LLM）
 * 2. **没命中才问模型，且只问一次**（一条 switch 上挂着多条 classifier 出边）
 * 3. **命中的那条规则的子工作流真的跑了**
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-routing
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { FlowNode } from '../src/flow/types.ts'

/** 一个只认 `always` 的假词表。 */
const vocabulary = {
  normalizeCondition(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    const kind = record['kind']
    // 只放行本用例用到的两种：`from`（确定性）与 `classifier`（要模型）。
    if (kind !== 'from' && kind !== 'classifier') return undefined
    return { ...record, kind } as never
  },
  normalizeAction(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } : undefined
  },
}

/** 把 config.note 写进节点说明的假动作。 */
function markNode(): FlowNode {
  return {
    type: 'mark',
    label: '标记',
    group: 'action',
    sideEffect: false,
    config: { note: { type: 'string', label: '说明' } },
    async run(spec) {
      const note = typeof spec.config?.['note'] === 'string' ? spec.config['note'] : '(无)'
      return { ok: true, detail: note }
    },
  }
}

/** 假连接器：一个触发器、`from` 条件、以及会计数的分类节点。 */
function connector(counter: { classify: number; label: string }): TaskConnector {
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
      async run(event) {
        const payload = event.payload as { id?: string }
        return {
          status: 'continue',
          ok: true,
          detail: '收到',
          seed: { key: `fake:${payload.id ?? 'one'}`, title: '一件事' },
        }
      },
    }],
    actions: [],
    nodes: [markNode()],
    judge: {
      conditions: {
        get: (kind: string) => {
          if (kind === 'from') {
            return {
              kind: 'from',
              async test(spec: { any?: readonly string[] }, context: { from: string }) {
                return (spec.any ?? []).includes(context.from)
              },
            }
          }
          if (kind === 'classifier') {
            return {
              kind: 'classifier',
              async: true,
              needsBody: false,
              async test(spec: { labels?: readonly string[] }, context: { classify?: (input: never) => Promise<{ label: string }> }) {
                const answer = await context.classify?.({ labels: spec.labels } as never)
                const label = answer?.label ?? 'uncertain'
                return (spec.labels ?? []).includes(label)
              },
            }
          }
          return undefined
        },
      } as never,
      plan: (request: { event: { payload?: unknown } }) => ({
        context: () => ({
          from: ((request.event.payload ?? {}) as { from?: string }).from ?? '',
          classify: async () => {
            const answer = await (request as unknown as { classification: () => Promise<{ label: string; confidence: number }> }).classification()
            return { label: answer.label, confidence: answer.confidence }
          },
        }),
        readBody: async () => Promise.resolve(''),
      }),
    } as never,
    classify: {
      node: {
        kind: 'classify',
        async run() {
          counter.classify += 1
          return { status: 'continue', ok: true, detail: '分类完毕', label: counter.label, confidence: 0.9 }
        },
      } as never,
      plan: () => undefined,
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

/** 事件流：确定性命中 A；标签命中 B；其余落 C。 */
const EVENT_FLOW = [
  'id: fake-new',
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
  '      - to: call-A',
  '        when: [{ kind: from, any: [a@b.c] }]',
  '      - to: call-B',
  '        when: [{ kind: classifier, labels: [x] }]',
  '      - to: call-C',
  '  - id: call-A',
  '    type: workflow',
  '    config: { workflow: wf-A }',
  '    out: [{ to: end }]',
  '  - id: call-B',
  '    type: workflow',
  '    config: { workflow: wf-B }',
  '    out: [{ to: end }]',
  '  - id: call-C',
  '    type: workflow',
  '    config: { workflow: wf-C }',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

/** 一个只做一件事的子工作流。 */
function workflow(id: string, note: string): string {
  return [
    `id: ${id}`,
    `name: ${id}`,
    'connector: fake',
    'nodes:',
    '  - id: only',
    '    type: mark',
    `    config: { note: ${note} }`,
    '',
  ].join('\n')
}

/** 起一台引擎。 */
async function boot(counter: { classify: number; label: string }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-routing-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  mkdirSync(join(home, 'workflows'), { recursive: true })
  writeFileSync(join(home, 'events', 'fake-new.yml'), EVENT_FLOW, 'utf8')
  writeFileSync(join(home, 'workflows', 'wf-A.yml'), workflow('wf-A', '走了 A'), 'utf8')
  writeFileSync(join(home, 'workflows', 'wf-B.yml'), workflow('wf-B', '走了 B'), 'utf8')
  writeFileSync(join(home, 'workflows', 'wf-C.yml'), workflow('wf-C', '走了 C'), 'utf8')
  const engine = new TaskEngine({ home })
  engine.register(connector(counter))
  await engine.start()
  return engine
}

/** 跑一个事件，返回它留下的节点说明。 */
async function run(counter: { classify: number; label: string }, from: string): Promise<string[]> {
  const engine = await boot(counter)
  await engine.emit({ type: 'fake.new', source: 'fake', payload: { id: from, from } } as never)
  await engine.flush()
  const task = engine.view().tasks[0]
  const details = (task?.nodes ?? []).map(node => node.kind + ':' + (node.detail ?? ''))
  engine.stop()
  return details
}

describe('事件 → 路由 → 子工作流', () => {
  it('确定性条件命中：走 A，且一次模型都没问', async () => {
    const counter = { classify: 0, label: 'x' }
    const details = await run(counter, 'a@b.c')
    expect(details.some(text => text.includes('走了 A'))).toBe(true)
    expect(details.some(text => text.includes('走了 B'))).toBe(false)
    expect(counter.classify).toBe(0)
  })

  it('确定性没中：问一次模型，标签命中就走 B', async () => {
    const counter = { classify: 0, label: 'x' }
    const details = await run(counter, 'other@x.y')
    expect(details.some(text => text.includes('走了 B'))).toBe(true)
    expect(counter.classify).toBe(1)
  })

  it('标签也不中：落到兜底 C', async () => {
    const counter = { classify: 0, label: '别的' }
    const details = await run(counter, 'other@x.y')
    expect(details.some(text => text.includes('走了 C'))).toBe(true)
    expect(counter.classify).toBe(1)
  })
})
