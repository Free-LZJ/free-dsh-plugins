/**
 * 一次补齐所有缺端点的子工作流。
 *
 * 11 张子工作流里很多只有一两个动作节点，点进去看不出「从哪进、到哪出」。一张张点
 * 「补开始/结束」太啰嗦，所以有批量入口；但批量改文件必须先备份——改坏了要能拷回来。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-scaffold-all
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    return typeof record['kind'] === 'string' ? { kind: record['kind'] } as never : undefined
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
        return { status: 'continue', ok: true, detail: '收到' }
      },
    }],
    actions: [],
    // 这两类节点得认识，否则解析期会把节点标成「不认识」并丢掉它的出边。
    nodes: [
      { type: 'markRead', label: '标记已读', group: 'action', async run() { return { status: 'continue', ok: true } } },
      { type: 'move', label: '移动', group: 'action', async run() { return { status: 'continue', ok: true } } },
    ],
    judge: {
      conditions: { get: () => undefined },
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
  } as never
}

/** 只有动作、没有端点的子工作流：`markRead → move`。 */
const BARE = [
  'id: promo',
  'name: 带退订头的群发',
  'connector: fake',
  'nodes:',
  '  - id: promo__0',
  '    type: markRead',
  '    out: [{ to: promo__1 }]',
  '  - id: promo__1',
  '    type: move',
  '    config: { folder: 推广 }',
  '',
].join('\n')

/** 已经有开始、缺结束的那张：只该补一个。 */
const HALF = [
  'id: half',
  'name: 半张图',
  'connector: fake',
  'nodes:',
  '  - id: start',
  '    type: start',
  '    out: [{ to: half__0 }]',
  '  - id: half__0',
  '    type: markRead',
  '',
].join('\n')

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-scaffold-'))
  mkdirSync(join(home, 'workflows'), { recursive: true })
  writeFileSync(join(home, 'workflows', 'promo.yml'), BARE, 'utf8')
  writeFileSync(join(home, 'workflows', 'half.yml'), HALF, 'utf8')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch { /* 临时目录，删不掉无妨 */ }
})

async function boot() {
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return engine
}

describe('一次补齐所有端点', () => {
  it('缺的开始/结束都补上，连线按图的形状接：开始接入口，末尾接结束', async () => {
    const engine = await boot()
    const result = await engine.scaffoldFlows()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 张')

    const promo = engine.flowView().flows.find(flow => flow.id === 'promo')
    const start = promo?.nodes.find(node => node.type === 'start')
    const end = promo?.nodes.find(node => node.type === 'end')
    expect(start).toBeTruthy()
    expect(end).toBeTruthy()
    // 开始只接原来的入口（promo__0），不是把所有节点都接上。
    expect(start?.out?.map(edge => edge.to)).toEqual(['promo__0'])
    // 原来没有出边的末尾（promo__1）接到结束。
    const tail = promo?.nodes.find(node => node.id === 'promo__1')
    expect(tail?.out?.map(edge => edge.to)).toEqual([end?.id])
    engine.stop()
  })

  it('只缺一个就只补一个：不会给已经有开始的那张再加一个开始', async () => {
    const engine = await boot()
    await engine.scaffoldFlows()
    const half = engine.flowView().flows.find(flow => flow.id === 'half')
    expect(half?.nodes.filter(node => node.type === 'start')).toHaveLength(1)
    expect(half?.nodes.filter(node => node.type === 'end')).toHaveLength(1)
    engine.stop()
  })

  it('改之前先备份：每张要动的图都留一个 .bak-scaffold-*', async () => {
    const engine = await boot()
    await engine.scaffoldFlows()
    engine.stop()

    const backups = readdirSync(join(home, 'workflows')).filter(name => name.includes('.bak-scaffold-'))
    expect(backups).toHaveLength(2)
    // 备份是**改之前**的内容：里面还没有 start 节点。
    const original = backups.map(name => readFileSync(join(home, 'workflows', name), 'utf8')).join('\n')
    expect(original).toContain('promo__0')
    expect(original.includes('type: start') && original.includes('type: end')).toBe(false)
  })

  it('再点一次就没事可做，也不会反复追加节点', async () => {
    const engine = await boot()
    await engine.scaffoldFlows()
    const again = await engine.scaffoldFlows()
    expect(again.ok).toBe(true)
    expect(again.message).toBe('没有缺端点的子工作流')

    const promo = engine.flowView().flows.find(flow => flow.id === 'promo')
    expect(promo?.nodes.filter(node => node.type === 'start')).toHaveLength(1)
    engine.stop()
    // 第二次不该再写备份文件。
    expect(existsSync(join(home, 'workflows'))).toBe(true)
  })
})


