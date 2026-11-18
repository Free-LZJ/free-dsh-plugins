/**
 * 增删节点必须落到**它所在的那个文件**，并且不要凭空造一座孤岛。
 *
 * 这一组是回归用例，两条都是实测撞到的：
 *
 * 1. 引擎早就改成「一图一文件」了（事件流在 `events/*.yml`，子工作流在
 *    `workflows/*.yml`），但增删节点读文件时虽然定位到了那张图，**写回却固定写
 *    `rules.yml`**。于是点「+ 新增节点」什么也不会发生——新节点写进了一份没人读的
 *    文件，`rules.yml` 反而被覆盖成那张图的内容。
 * 2. 不指定「接在谁后面」时，新节点被追加到末尾且**没有任何入边**，永远跑不到。
 *    界面上看着加成功了，流程里其实是一座孤岛。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-node
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

/** 一个只会「标记」的假连接器。 */
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

/** 一条单链：trigger → route → end。末尾只有一个入口，加节点说得清接哪儿。 */
const CHAIN = [
  'id: demo',
  'trigger: fake:new',
  'connector: fake',
  'nodes:',
  '  - id: trigger',
  '    type: trigger',
  '    config: { event: fake.new }',
  '    out: [{ to: route }]',
  '  - id: route',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

/** 一张分叉的图：route 的两条边都直接连到 end，末尾有两个入口。 */
const FORK = [
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
  '      - to: call-b',
  '  - id: call-a',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: call-b',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

/** `rules.yml` 的哨兵内容：只要它被动过，说明写错了文件。 */
const RULES_SENTINEL = '# 这份文件不该被增删节点碰到\nversion: 2\nconnector: fake\nflows: []\n'

/** 起一个引擎：图在 `events/demo.yml`，`rules.yml` 另有一份内容。 */
async function boot(flow: string) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-flow-node-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'demo.yml'), flow, 'utf8')
  writeFileSync(join(home, 'rules.yml'), RULES_SENTINEL, 'utf8')
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return { engine, home }
}

/** 事件流文件现在的内容。 */
function flowText(home: string): string {
  return readFileSync(join(home, 'events', 'demo.yml'), 'utf8')
}

/** 从入口出发能不能走到某个节点——「孤岛」的判据。 */
function reachable(engine: TaskEngine, nodeId: string): boolean {
  const flow = engine.flowView().flows.find(item => item.id === 'demo')!
  const seen = new Set<string>()
  const queue = flow.nodes.filter(node => node.type === 'trigger').map(node => node.id)
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    if (current === nodeId) return true
    for (const edge of flow.nodes.find(node => node.id === current)?.out ?? []) queue.push(edge.to)
  }
  return false
}

describe('新增节点', () => {
  it('写回它所在的那个文件，不碰 rules.yml', async () => {
    const { engine, home } = await boot(CHAIN)
    const added = await engine.addFlowNode({ after: 'route', type: 'mark', flowId: 'demo' })
    expect(added.ok).toBe(true)
    expect(flowText(home)).toContain('mark__')
    expect(readFileSync(join(home, 'rules.yml'), 'utf8')).toBe(RULES_SENTINEL)
    engine.stop()
  })

  it('不指定前驱时接在唯一的末尾之前，新节点从入口走得到', async () => {
    const { engine } = await boot(CHAIN)
    const added = await engine.addFlowNode({ type: 'mark', flowId: 'demo' })
    expect(added.ok).toBe(true)
    const nodeId = added.ok ? added.nodeId : undefined
    expect(nodeId).toBeDefined()
    if (nodeId !== undefined) expect(reachable(engine, nodeId)).toBe(true)
    engine.stop()
  })

  it('末尾有多个入口时不猜，说清楚要先选一个', async () => {
    const { engine } = await boot(FORK)
    const added = await engine.addFlowNode({ type: 'mark', flowId: 'demo' })
    expect(added.ok).toBe(false)
    if (!added.ok) expect(added.message).toContain('选中')
    engine.stop()
  })

  it('指定的前驱不在图上时拒绝', async () => {
    const { engine } = await boot(CHAIN)
    const added = await engine.addFlowNode({ after: 'nope', type: 'mark', flowId: 'demo' })
    expect(added.ok).toBe(false)
    engine.stop()
  })
})

/** 一张带坐标的图：`mark` 在 (0,0)，`end` 在 (0,400)。 */
const PLACED = [
  'id: demo',
  'trigger: fake:new',
  'connector: fake',
  'nodes:',
  '  - id: trigger',
  '    type: trigger',
  '    pos: { x: 0, y: 0 }',
  '    config: { event: fake.new }',
  '    out: [{ to: route }]',
  '  - id: route',
  '    type: mark',
  '    pos: { x: 0, y: 200 }',
  '  - id: end',
  '    type: end',
  '    pos: { x: 0, y: 400 }',
  '',
].join('\n')

/** 同一张图，但下一层空着：`end` 退到 (0,900)。 */
const SPACED = PLACED.replace('pos: { x: 0, y: 400 }', 'pos: { x: 0, y: 900 }')

/** 某个节点现在的坐标。 */
function posOf(engine: TaskEngine, nodeId: string): { x: number; y: number } | undefined {
  const flow = engine.flowView().flows.find(item => item.id === 'demo')
  return flow?.nodes.find(node => node.id === nodeId)?.pos
}

describe('新增节点的落点', () => {
  it('摆在它上游的下一层，不是 (0,0)', async () => {
    const { engine } = await boot(SPACED)
    const added = await engine.addFlowNode({ after: 'route', type: 'mark', flowId: 'demo' })
    const pos = posOf(engine, added.ok ? added.nodeId! : '')
    // 不写坐标的话这里会是 (0,0)——正好压在 trigger 身上，看着像没加进去。
    expect(pos).not.toEqual({ x: 0, y: 0 })
    expect(pos?.x).toBe(0)
    expect(pos!.y).toBeGreaterThan(200)
    engine.stop()
  })

  it('落点被占了就往右让一列，不叠在别人身上', async () => {
    const { engine } = await boot(PLACED)
    const added = await engine.addFlowNode({ after: 'route', type: 'mark', flowId: 'demo' })
    const pos = posOf(engine, added.ok ? added.nodeId! : '')
    // route 在 (0,200)，下一层 (0,400) 是 end 的地盘。
    expect(pos!.x).toBeGreaterThan(0)
    engine.stop()
  })

  it('不指定前驱时摆到整张图的下方，不压住任何节点', async () => {
    const { engine } = await boot(SPACED)
    const added = await engine.addFlowNode({ type: 'mark', flowId: 'demo' })
    const pos = posOf(engine, added.ok ? added.nodeId! : '')
    expect(pos!.y).toBeGreaterThan(900)
    engine.stop()
  })
})

describe('删除节点', () => {
  it('写回它所在的那个文件，不碰 rules.yml', async () => {
    const { engine, home } = await boot(CHAIN)
    const removed = await engine.removeFlowNode('route')
    expect(removed.ok).toBe(true)
    expect(flowText(home)).not.toContain('id: route')
    expect(readFileSync(join(home, 'rules.yml'), 'utf8')).toBe(RULES_SENTINEL)
    engine.stop()
  })

  it('删完之后前一步接到后一步，流程不断', async () => {
    const { engine } = await boot(CHAIN)
    await engine.removeFlowNode('route')
    const flow = engine.flowView().flows.find(item => item.id === 'demo')!
    expect(flow.nodes.find(node => node.id === 'trigger')?.out?.map(edge => edge.to)).toEqual(['end'])
    engine.stop()
  })
})
