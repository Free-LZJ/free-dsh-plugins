/**
 * 端到端：`events/` 与 `workflows/` 两个目录 → 引擎 → 事件按触发器取图。
 *
 * 这里要证明的是**归属层级换了**：规则不再挂在连接器上，而是挂在具体的触发器上。
 * 一个连接器有多个事件时，各自走自己那张图，互不串。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-events
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { FlowNode } from '../src/flow/types.ts'

/** 一个只认 `always` 条件的词表。 */
const vocabulary = {
  normalizeCondition(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return record['kind'] === 'always' ? { kind: 'always' } : undefined
  },
  normalizeAction(input: unknown) {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as Record<string, unknown>
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } : undefined
  },
}

/** 一个把 config.note 写进节点说明的假动作。 */
const markNode: FlowNode = {
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

/** 假连接器：两个触发器（`fake:a` / `fake:b`）。 */
function connector(): TaskConnector {
  const trigger = (id: string, eventType: string) => ({
    kind: 'trigger' as const,
    id,
    connector: 'fake',
    listensTo: [eventType],
    async run() {
      return { status: 'continue' as const, ok: true, detail: '收到', seed: { key: `${id}:one`, title: '一件事' } }
    },
  })
  return {
    id: 'fake',
    label: '假连接器',
    directions: ['in'],
    implemented: true,
    triggers: [trigger('fake:a', 'fake.a'), trigger('fake:b', 'fake.b')],
    actions: [],
    nodes: [markNode],
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

/** 一张最小的事件流：一个动作，没有入边，它就是起点。 */
function eventFlow(id: string, trigger: string, note: string): string {
  return [
    `id: ${id}`,
    `trigger: ${trigger}`,
    'connector: fake',
    'nodes:',
    '  - id: only',
    '    type: mark',
    `    config: { note: ${note} }`,
    '',
  ].join('\n')
}

/** 起一台引擎，准备好目录。 */
async function boot(files: { events?: Record<string, string>; workflows?: Record<string, string> }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-flow-events-'))
  if (files.events !== undefined) {
    mkdirSync(join(home, 'events'), { recursive: true })
    for (const [name, text] of Object.entries(files.events)) {
      writeFileSync(join(home, 'events', name), text, 'utf8')
    }
  }
  if (files.workflows !== undefined) {
    mkdirSync(join(home, 'workflows'), { recursive: true })
    for (const [name, text] of Object.entries(files.workflows)) {
      writeFileSync(join(home, 'workflows', name), text, 'utf8')
    }
  }
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return { engine, home }
}

describe('事件流与子工作流的加载', () => {
  it('按 trigger 字段建好映射，工作流按 id 取得到', async () => {
    const { engine } = await boot({
      events: { 'fake-a.yml': eventFlow('fake-a', 'fake:a', 'A') },
      workflows: { 'w1.yml': 'id: w1\nname: 工作流一\nconnector: fake\nnodes:\n  - id: only\n    type: mark\n    config: { note: W }\n' },
    })
    expect(engine.eventFlowOf('fake:a')?.id).toBe('fake-a')
    expect(engine.eventFlowOf('fake:b')).toBeUndefined()
    expect(engine.workflowOf('w1')?.name).toBe('工作流一')
    expect(engine.eventFlowList()).toHaveLength(1)
    expect(engine.workflowList()).toHaveLength(1)
    engine.stop()
  })

  it('两个事件各走自己那张图，互不串', async () => {
    const { engine } = await boot({
      events: {
        'fake-a.yml': eventFlow('fake-a', 'fake:a', '走了 A'),
        'fake-b.yml': eventFlow('fake-b', 'fake:b', '走了 B'),
      },
    })
    await engine.emit({ type: 'fake.a', source: 'fake', payload: {} } as never)
    await engine.flush()
    const first = engine.view().tasks[0]
    expect(first?.nodes.some(node => node.detail === '走了 A')).toBe(true)
    expect(first?.nodes.some(node => node.detail === '走了 B')).toBe(false)

    await engine.emit({ type: 'fake.b', source: 'fake', payload: {} } as never)
    await engine.flush()
    const second = engine.view().tasks.find(task => task.id !== first?.id)
    expect(second?.nodes.some(node => node.detail === '走了 B')).toBe(true)
    expect(second?.nodes.some(node => node.detail === '走了 A')).toBe(false)
    engine.stop()
  })

  it('没写 trigger 的事件流接不到事件（会被跳过）', async () => {
    const { engine } = await boot({
      events: {
        'orphan.yml': 'id: orphan\nconnector: fake\nnodes:\n  - id: only\n    type: mark\n    config: { note: 孤儿 }\n',
        'fake-a.yml': eventFlow('fake-a', 'fake:a', 'A'),
      },
    })
    expect(engine.eventFlowList()).toHaveLength(1)
    expect(engine.eventFlowOf('fake:a')?.id).toBe('fake-a')
    engine.stop()
  })

  it('同一触发器写了两张事件流时只留第一张（按文件名序）', async () => {
    const { engine } = await boot({
      events: {
        'a-first.yml': eventFlow('a-first', 'fake:a', '第一'),
        'b-second.yml': eventFlow('b-second', 'fake:a', '第二'),
      },
    })
    expect(engine.eventFlowOf('fake:a')?.id).toBe('a-first')
    engine.stop()
  })
})
