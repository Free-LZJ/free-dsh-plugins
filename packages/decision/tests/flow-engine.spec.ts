/**
 * 端到端：一份 v2 规则文件 → 引擎 → 真事件 → 图上跑一遍 → 任务记录。
 *
 * 这条链路前面各段都有单测（解析、执行、布局），只有这里把它们串起来。它要证明的是：
 * 引擎**认得 version: 2**，事件进来走的是图而不是旧的规则列表。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-engine
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import { runsOf } from '../src/task/record.ts'
import type { TaskConnector } from '../src/task/connector.ts'
import type { FlowNode } from '../src/flow/types.ts'
import type { ActionNode, ActionSpecLike } from '../src/task/index.ts'
import type { TaskContext } from '../src/task/context.ts'

/** 一份最小的 v2 文件：触发 → 分支 → 两个动作之一。 */
const FLOW_FILE = `version: 2
connector: fake
flows:
  - id: fake-flow
    name: 假流程
    nodes:
      - id: start
        type: switch
        out:
          - { to: yes, when: [{ kind: 'always' }] }
          - { to: no }
      - id: yes
        type: mark
        config: { note: 走了 yes }
      - id: no
        type: mark
        config: { note: 走了 no }
`

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

/** 一个假动作：把 config.note 写进节点说明。 */
const markAction: ActionNode<ActionSpecLike, TaskContext> = {
  kind: 'mark',
  sideEffect: false,
  async run(spec: ActionSpecLike) {
    const note = (spec as unknown as { note?: string }).note ?? '(无)'
    return { ok: true, detail: note }
  },
} as unknown as ActionNode<ActionSpecLike, TaskContext>

/** 假连接器：一个触发器 + 一个动作 + 一个条件。 */
function connector(): TaskConnector {
  const nodes: readonly FlowNode[] = [
    {
      type: 'mark',
      label: '标记',
      group: 'action',
      sideEffect: false,
      config: { note: { type: 'string', label: '说明' } },
      async run(spec) {
        const note = typeof spec.config?.['note'] === 'string' ? spec.config['note'] : '(无)'
        return { ok: true, detail: note }
      },
    },
  ]
  return {
    id: 'fake',
    label: '假连接器',
    directions: ['in'],
    implemented: true,
    triggers: [{
      kind: 'trigger',
      id: 'fake:new',
      connector: 'fake',
      listensTo: ['fake.received'],
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
    actions: [markAction],
    nodes,
    judge: {
      conditions: {
        get: (kind: string) => kind === 'always'
          ? { kind: 'always', async test() { return true } }
          : undefined,
      } as never,
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

/** 起一台引擎，装假连接器。 */
async function boot(source: string) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-flow-engine-'))
  writeFileSync(join(home, 'rules.yml'), source, 'utf8')
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return { engine, home }
}

describe('引擎跑节点图', () => {
  it('v2 文件被认出来，事件走图而不是旧规则', async () => {
    const { engine } = await boot(FLOW_FILE)
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'one' } } as never)
    await engine.flush()

    const task = engine.view().tasks[0]
    expect(task).toBeDefined()
    // 图里走过的节点：switch 与命中的那条动作。
    const kinds = task?.nodes.map(node => node.kind)
    expect(kinds).toContain('switch')
    expect(kinds).toContain('mark')
    // 图里跑的格子都带 runId（触发器那格属于任务创建，不算一轮）。
    expect(task?.nodes.filter(node => node.kind !== 'trigger').every(node => node.runId !== undefined)).toBe(true)
    expect(task?.runId).toBeDefined()
    engine.stop()
  })

  it('命中的分支执行，未命中的不执行', async () => {
    const { engine } = await boot(FLOW_FILE)
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'two' } } as never)
    await engine.flush()

    const task = engine.view().tasks[0]
    const marks = task?.nodes.filter(node => node.kind === 'mark') ?? []
    expect(marks).toHaveLength(1)
    expect(marks[0]?.detail).toBe('走了 yes')
    engine.stop()
  })

  it('进度被落盘，任务状态是 done', async () => {
    const { engine } = await boot(FLOW_FILE)
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'three' } } as never)
    await engine.flush()

    const task = engine.view().tasks[0]
    expect(task?.status).toBe('done')
    expect(task?.progress?.done.length).toBeGreaterThan(0)
    engine.stop()
  })

  it('每一格记录都带着它在图上的节点 id', async () => {
    const { engine } = await boot(FLOW_FILE)
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'traced' } } as never)
    await engine.flush()

    const task = engine.view().tasks[0]!
    // 图里跑过的每一格都能标回具体方块；触发器那格来自任务创建，没有 id。
    const graphNodes = task.nodes.filter(node => node.kind !== 'trigger')
    expect(graphNodes.length).toBeGreaterThan(0)
    for (const node of graphNodes) {
      expect(node.nodeId, `${node.kind} 这格应该有 nodeId`).toBeTypeOf('string')
    }
    // 而且这些 id 真的在图里。
    const ids = new Set(engine.flowView().flows[0]!.nodes.map(node => node.id))
    for (const node of graphNodes) expect(ids.has(node.nodeId as string)).toBe(true)
    engine.stop()
  })
  it('同一件事发生两次 = 两轮执行，各自从入口跑，不重放上一轮', async () => {
    const { engine } = await boot(FLOW_FILE)
    const event = { type: 'fake.received', source: 'fake', payload: { id: 'same' } }
    // 同一个 seed key（同一件事），没有 dedupeKey（不是同一事实的重复投递）。
    await engine.emit(event as never)
    await engine.emit(event as never)
    await engine.flush()

    const tasks = engine.view().tasks
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    const runs = runsOf(task)
    expect(runs).toHaveLength(2)
    // 每一轮都完整走过 switch 与 mark，互不干扰。
    for (const run of runs) {
      expect(run.nodes.map(node => node.kind)).toContain('switch')
      expect(run.nodes.filter(node => node.kind === 'mark')).toHaveLength(1)
    }
    // 两轮的 runId 不同，节点总数是 2 轮的量。
    expect(new Set(runs.map(run => run.id)).size).toBe(2)
    expect(task.nodes.filter(node => node.kind === 'mark')).toHaveLength(2)
    engine.stop()
  })

  it('同一事实重复投递只跑一轮', async () => {
    const { engine } = await boot(FLOW_FILE)
    const event = { type: 'fake.received', source: 'fake', dedupeKey: 'fact-1', payload: { id: 'dup' } }
    await engine.emit(event as never)
    await engine.emit(event as never)
    await engine.flush()

    const task = engine.view().tasks[0]
    expect(runsOf(task!)).toHaveLength(1)
    expect(task?.nodes.filter(node => node.kind === 'mark')).toHaveLength(1)
    engine.stop()
  })

  it('插入一个节点：接管前一步的出路，前后仍然连通', async () => {
    const { engine, home } = await boot(FLOW_FILE)
    const added = await engine.addFlowNode({ after: 'start', type: 'mark', config: { note: '插进来的' } })
    expect(added.ok).toBe(true)
    const newNodeId = added.ok ? added.nodeId : undefined
    expect(newNodeId).toBeDefined()

    const text = readFileSync(join(home, 'rules.yml'), 'utf8')
    // 前一步只指向新节点。
    const flow = engine.flowView().flows[0]!
    const start = flow.nodes.find(node => node.id === 'start')!
    expect(start.out?.map(edge => edge.to)).toEqual([newNodeId])
    // 新节点继承了 start 原来的两条出边（yes / no）。
    const inserted = flow.nodes.find(node => node.id === newNodeId)!
    expect(inserted.out?.map(edge => edge.to).sort()).toEqual(['no', 'yes'])
    expect(text).toContain('插进来的')
    engine.stop()
  })

  it('插入节点不碰别的节点的注释', async () => {
    const annotated = `# 文件头注释
version: 2
connector: fake
flows:
  - id: fake-flow
    nodes:
      # 这是 start 的注释
      - id: start
        type: mark
      - id: tail
        type: end
`
    const { engine, home } = await boot(annotated)
    await engine.addFlowNode({ after: 'start', type: 'mark' })
    const text = readFileSync(join(home, 'rules.yml'), 'utf8')
    expect(text).toContain('# 文件头注释')
    expect(text).toContain('# 这是 start 的注释')
    engine.stop()
  })

  it('删一个节点：入边改接它的下一个，流程不断', async () => {
    const { engine } = await boot(FLOW_FILE)
    // start → yes/no；删掉 yes 之后，start 的那条分支应该断（yes 是终点，没有下家）
    const removed = await engine.removeFlowNode('yes')
    expect(removed.ok).toBe(true)
    const flow = engine.flowView().flows[0]!
    expect(flow.nodes.some(node => node.id === 'yes')).toBe(false)
    // 指向 yes 的边被摘掉，而不是留一条指向空气的边。
    for (const node of flow.nodes) {
      for (const edge of node.out ?? []) {
        expect(flow.nodes.some(item => item.id === edge.to)).toBe(true)
      }
    }
    engine.stop()
  })

  it('删中间节点时入边接到它的出边', async () => {
    const chain = `version: 2
connector: fake
flows:
  - id: f
    nodes:
      - id: a
        type: mark
        out: [{ to: b }]
      - id: b
        type: mark
        out: [{ to: c }]
      - id: c
        type: end
`
    const { engine } = await boot(chain)
    await engine.removeFlowNode('b')
    const flow = engine.flowView().flows[0]!
    expect(flow.nodes.find(node => node.id === 'a')?.out?.map(edge => edge.to)).toEqual(['c'])
    engine.stop()
  })

  it('把一条边改指向另一个节点，条件跟着走', async () => {
    const { engine } = await boot(FLOW_FILE)
    // switch 的第 1 条出边本来指向 yes（带 when），改到 no 上。
    const relinked = await engine.relinkFlowEdge({ from: 'start', index: 0, to: 'no' })
    expect(relinked.ok).toBe(true)
    const start = engine.flowView().flows[0]!.nodes.find(node => node.id === 'start')!
    expect(start.out?.[0]?.to).toBe('no')
    // 条件没被换目标冲掉。
    expect(start.out?.[0]?.when).toBeDefined()
    engine.stop()
  })

  it('删掉一条边，分支少一个出口', async () => {
    const { engine } = await boot(FLOW_FILE)
    const before = engine.flowView().flows[0]!.nodes.find(node => node.id === 'start')!.out?.length ?? 0
    await engine.relinkFlowEdge({ from: 'start', index: 1 })
    const after = engine.flowView().flows[0]!.nodes.find(node => node.id === 'start')!.out?.length ?? 0
    expect(after).toBe(before - 1)
    engine.stop()
  })

  it('改到不存在的目标会被拒绝，文件不动', async () => {
    const { engine } = await boot(FLOW_FILE)
    const result = await engine.relinkFlowEdge({ from: 'start', index: 0, to: 'nowhere' })
    expect(result.ok).toBe(false)
    expect(engine.flowView().flows[0]!.nodes.find(node => node.id === 'start')!.out?.[0]?.to).toBe('yes')
    engine.stop()
  })
  it('插一个不认识的类型会被拒绝', async () => {
    const { engine } = await boot(FLOW_FILE)
    const added = await engine.addFlowNode({ after: 'start', type: 'no-such-type' })
    expect(added.ok).toBe(false)
    engine.stop()
  })
  it('保存一个节点只改那一处，注释与其余节点原样留着', async () => {
    const annotated = `# 这份文件的注释是给人看的，保存不该把它抹掉
version: 2
connector: fake
flows:
  - id: fake-flow
    # 流程级别的注释
    nodes:
      - id: start
        type: switch
        out:
          - { to: yes, when: [{ kind: 'always' }] }
          - { to: no }
      - id: yes
        type: mark
        config:
          note: 原来
      - id: no
        type: mark
`
    const { engine, home } = await boot(annotated)
    const saved = await engine.saveFlowNode({
      nodeId: 'yes',
      config: { note: '改过了' },
      pos: { x: 100, y: 200 },
    })
    expect(saved.ok).toBe(true)

    const text = readFileSync(join(home, 'rules.yml'), 'utf8')
    // 注释还在。
    expect(text).toContain('# 这份文件的注释是给人看的')
    expect(text).toContain('# 流程级别的注释')
    // 改的那处生效了。
    expect(text).toContain('改过了')
    expect(text).toContain('x: 100')
    // 没碰的节点还在。
    expect(text).toContain('id: no')
    engine.stop()
  })

  it('保存后立刻生效，不用重启', async () => {
    const { engine } = await boot(FLOW_FILE)
    expect(engine.flowView().flows[0]?.nodes.find(node => node.id === 'yes')?.config).toEqual({ note: '走了 yes' })
    await engine.saveFlowNode({ nodeId: 'yes', config: { note: '新的说明' } })
    expect(engine.flowView().flows[0]?.nodes.find(node => node.id === 'yes')?.config).toEqual({ note: '新的说明' })
    engine.stop()
  })

  it('改一个不存在的节点会说明原因，而不是静默失败', async () => {
    const { engine } = await boot(FLOW_FILE)
    const saved = await engine.saveFlowNode({ nodeId: 'no-such-node', label: 'x' })
    expect(saved.ok).toBe(false)
    expect(saved.ok === false ? saved.message : '').toContain('找不到节点')
    engine.stop()
  })
  it('v1 文件仍然走旧路径，不因为新引擎而失效', async () => {    const v1 = `version: 1
connector: fake
rules:
  - id: only
    name: 唯一规则
    priority: 10
    when: []
    then:
      - kind: mark
`
    const { engine } = await boot(v1)
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'four' } } as never)
    await engine.flush()

    const task = engine.view().tasks[0]
    expect(task).toBeDefined()
    // 旧路径没有 progress，也没有 runId。
    expect(task?.progress).toBeUndefined()
    expect(task?.runId).toBeUndefined()
    engine.stop()
  })
})
