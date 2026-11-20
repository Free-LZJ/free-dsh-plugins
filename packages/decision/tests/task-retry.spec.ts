/**
 * 端到端：一条失败的任务可以重跑。
 *
 * 重跑不是「接着跑」：上一轮已经收场（`partial`），这里要证明的是**同一个事件再开
 * 一轮**——状态回到 `done`、`runId` 换新、上一轮的节点记录还在（历史不被覆盖），
 * 以及没有失败 / 任务不存在时如实拒绝。
 *
 * @module @free-lzj/dsh-decision/tests/task-retry
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { FlowNode } from '../src/flow/types.ts'

/** 第一次跑必失败、`state.ok` 翻过来就成功的动作。 */
function boomNode(state: { ok: boolean }): FlowNode {
  return {
    type: 'boom',
    label: '会失败的动作',
    group: 'action',
    async run() {
      if (state.ok) return { ok: true, detail: '这次成了' }
      return { ok: false, failure: 'transient', detail: '网络抽风' }
    },
  }
}

/** 一台假连接器，只带一个触发器和一个会失败的动作。 */
function connector(state: { ok: boolean }): TaskConnector {
  return {
    id: 'fake',
    label: '假连接器',
    directions: ['in'],
    implemented: true,
    triggers: [{
      kind: 'trigger',
      id: 'fake:a',
      connector: 'fake',
      listensTo: ['fake.a'],
      async run() {
        return { status: 'continue', ok: true, detail: '收到', seed: { key: 'fake:a:one', title: '一件事' } }
      },
    }],
    actions: [],
    nodes: [boomNode(state)],
    judge: {
      conditions: { get: () => undefined } as never,
      plan: () => ({ context: () => ({}), readBody: async () => '' }),
    } as never,
    vocabulary: {
      normalizeCondition: () => undefined,
      normalizeAction: () => undefined,
    } as never,
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

/** 起一台引擎，写一张「一个动作」的事件流。 */
async function boot(state: { ok: boolean }): Promise<TaskEngine> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-task-retry-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'a.yml'), [
    'id: a',
    'trigger: fake:a',
    'connector: fake',
    'nodes:',
    '  - id: b',
    '    type: boom',
    '',
  ].join('\n'), 'utf8')
  const engine = new TaskEngine({ home })
  engine.register(connector(state))
  await engine.start()
  return engine
}

describe('重跑失败的任务（引擎层）', () => {
  it('重试换一轮再跑，上一轮的记录留着', async () => {
    const state = { ok: false }
    const engine = await boot(state)
    await engine.emit({ type: 'fake.a', source: 'fake', payload: {} } as never)
    await engine.flush()
    const first = engine.view().tasks[0]
    expect(first?.status).toBe('partial')
    expect(first?.nodes.some(node => node.detail === '网络抽风')).toBe(true)

    state.ok = true
    const result = await engine.retry(first?.id as string)
    expect(result.ok).toBe(true)
    const after = engine.view().tasks[0]
    expect(after?.status).toBe('done')
    // 换了一轮：runId 不是上一轮那个。
    expect(after?.runId).toBeDefined()
    expect(after?.runId).not.toBe(first?.runId)
    // 两轮的记录都在：失败那句没被覆盖，成功那句是新的。
    expect(after?.nodes.some(node => node.detail === '网络抽风')).toBe(true)
    expect(after?.nodes.some(node => node.detail === '这次成了')).toBe(true)
    engine.stop()
  })

  it('没失败的任务不给重试', async () => {
    const engine = await boot({ ok: true })
    await engine.emit({ type: 'fake.a', source: 'fake', payload: {} } as never)
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('done')
    const result = await engine.retry(task?.id as string)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有失败')
    engine.stop()
  })

  it('找不到任务时说实话', async () => {
    const engine = await boot({ ok: true })
    const result = await engine.retry('nope')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('找不到任务')
    engine.stop()
  })
})
