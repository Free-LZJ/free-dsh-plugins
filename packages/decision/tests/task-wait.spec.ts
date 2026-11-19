/**
 * 端到端：动作「派发成功但要等回信」→ 挂起 → 唤醒 → 续跑。
 *
 * 这一层要证明的是**挂起不是失败**：看板上它停在「等回信」，进度里有令牌与到期时间，
 * 唤醒后从那一格接着跑，而不是重开一条链。
 *
 * @module @free-lzj/dsh-decision/tests/task-wait
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { FlowNode } from '../src/flow/types.ts'

/** 一个「派发后挂起，醒来才算完」的节点。 */
const holdNode: FlowNode = {
  type: 'hold',
  label: '等回信',
  group: 'action',
  config: { token: { type: 'string', label: '令牌' }, dueAt: { type: 'string', label: '到期' } },
  async run(spec, context) {
    if (context.signal !== undefined) {
      return { ok: true, detail: `拿到 ${String(context.signal['answer'] ?? '(空)')}` }
    }
    const token = spec.config?.['token']
    const dueAt = spec.config?.['dueAt']
    return {
      ok: true,
      suspend: {
        on: 'event',
        ...(typeof token === 'string' ? { token } : {}),
        ...(typeof dueAt === 'string' ? { dueAt } : {}),
        resume: { ticket: 'T1' },
        detail: '等回信',
      },
    }
  },
}

/** 一台假连接器；`probeWait` 由测试决定什么时候说「好了」。 */
function connector(state: { ready: boolean; probed: string[] }): TaskConnector {
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
    nodes: [holdNode],
    async probeWait(wait) {
      state.probed.push(wait.token)
      return wait.token.startsWith('probe:') ? { ready: state.ready, payload: { answer: '探针' } } : undefined
    },
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

/** 起一台引擎，写好事件流与（可选的）子工作流。 */
async function boot(options: { event: string; workflows?: Record<string, string>; state?: { ready: boolean; probed: string[] } }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-task-wait-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'a.yml'), options.event, 'utf8')
  if (options.workflows !== undefined) {
    mkdirSync(join(home, 'workflows'), { recursive: true })
    for (const [name, text] of Object.entries(options.workflows)) writeFileSync(join(home, 'workflows', name), text, 'utf8')
  }
  const state = options.state ?? { ready: false, probed: [] }
  const engine = new TaskEngine({ home })
  engine.register(connector(state))
  await engine.start()
  return { engine, state }
}

/** 一张只有一个 hold 节点的事件流。 */
function eventFlow(config: string): string {
  return [
    'id: a',
    'trigger: fake:a',
    'connector: fake',
    'nodes:',
    '  - id: h',
    '    type: hold',
    `    config: ${config}`,
    '',
  ].join('\n')
}

/** 跑到「等回信」。 */
async function suspendOnce(engine: TaskEngine): Promise<void> {
  await engine.emit({ type: 'fake.a', source: 'fake', payload: {} } as never)
  await engine.flush()
}

describe('挂起与唤醒（引擎层）', () => {
  it('动作要等回信时任务挂起，令牌与到期时间落在进度里', async () => {
    const { engine } = await boot({ event: eventFlow('{ token: w:abc, dueAt: "2026-01-01T00:00:00.000Z" }') })
    await suspendOnce(engine)
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('suspended')
    expect(task?.progress?.pending).toMatchObject({
      nodeId: 'h',
      token: 'w:abc',
      dueAt: '2026-01-01T00:00:00.000Z',
      resume: { ticket: 'T1' },
    })
    expect(task?.nodes.some(node => node.detail === '等回信')).toBe(true)
    engine.stop()
  })

  it('拿对令牌唤醒后续跑，信号交给动作，任务收尾', async () => {
    const { engine } = await boot({ event: eventFlow('{ token: w:abc }') })
    await suspendOnce(engine)
    const result = await engine.resume({ token: 'w:abc', payload: { answer: '人批了' } })
    expect(result.ok).toBe(true)
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('done')
    expect(task?.progress?.pending).toBeUndefined()
    // 信号到了动作手里：它写下的正是载荷里的那句话。
    expect(task?.nodes.some(node => node.detail === '拿到 人批了')).toBe(true)
    // 先记「收到信号」，再记动作自己那格。
    expect(task?.nodes.some(node => node.detail.startsWith('收到信号'))).toBe(true)
    engine.stop()
  })

  it('令牌不对时拒绝唤醒，任务还在等', async () => {
    const { engine } = await boot({ event: eventFlow('{ token: w:abc }') })
    await suspendOnce(engine)
    const result = await engine.resume({ token: 'w:别的' })
    expect(result.ok).toBe(false)
    expect(engine.view().tasks[0]?.status).toBe('suspended')
    engine.stop()
  })

  it('到期没人唤醒就判失败，说明在等什么', async () => {
    const { engine } = await boot({ event: eventFlow('{ token: w:old, dueAt: "2020-01-01T00:00:00.000Z" }') })
    await suspendOnce(engine)
    await engine.runDue()
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('failed')
    expect(task?.nodes.some(node => node.detail.includes('等超时'))).toBe(true)
    engine.stop()
  })

  it('探针说好之前一直等，说好之后自动续跑', async () => {
    const state = { ready: false, probed: [] as string[] }
    const { engine } = await boot({ event: eventFlow('{ token: probe:1 }'), state })
    await suspendOnce(engine)

    await engine.runDue()
    expect(state.probed).toContain('probe:1')
    expect(engine.view().tasks[0]?.status).toBe('suspended')

    state.ready = true
    await engine.runDue()
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('done')
    expect(task?.nodes.some(node => node.detail === '拿到 探针')).toBe(true)
    engine.stop()
  })

  it('子工作流里挂起会提升成整条链挂起，唤醒后子图接着跑完', async () => {
    const event = [
      'id: a',
      'trigger: fake:a',
      'connector: fake',
      'nodes:',
      '  - id: call',
      '    type: workflow',
      '    config: { workflow: w1 }',
      '  - id: end',
      '    type: end',
      '',
    ].join('\n')
    const workflow = [
      'id: w1',
      'name: 子流程',
      'connector: fake',
      'nodes:',
      '  - id: sub-hold',
      '    type: hold',
      '    config: { token: w:sub }',
      '',
    ].join('\n')
    const { engine } = await boot({ event, workflows: { 'w1.yml': workflow } })
    await suspendOnce(engine)
    const paused = engine.view().tasks[0]
    expect(paused?.status).toBe('suspended')
    expect(paused?.progress?.pending?.nested?.flowId).toBe('w1')

    const result = await engine.resume({ token: 'w:sub', payload: { answer: '子图收到' } })
    expect(result.ok).toBe(true)
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('done')
    expect(task?.nodes.some(node => node.detail === '拿到 子图收到')).toBe(true)
    engine.stop()
  })
})
