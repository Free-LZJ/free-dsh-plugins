/**
 * 挪分支顺序：`分支`（switch）按文件里的顺序从上往下判定，第一个条件成立的赢。
 *
 * 守两件事：
 *
 * - 顺序**就是优先级**，挪一下就真的落盘（以前只能手改 YAML）；
 * - 条件跟着边走，不因为换位置丢掉。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-edge-order
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    nodes: [],
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

/** 三条出边：兜底排在第二条——正是「它后面那条永远走不到」的样子。 */
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
  '        when:',
  '          - kind: from',
  '            any:',
  '              - a@example.com',
  '      - to: call-b',
  '      - to: call-c',
  '        when:',
  '          - kind: from',
  '            any:',
  '              - c@example.com',
  '  - id: call-a',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: call-b',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: call-c',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-edge-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'demo.yml'), FLOW, 'utf8')
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

/** `route` 的出边，按判定顺序。 */
function routeOut(engine: TaskEngine): { to: string; when?: readonly unknown[] }[] {
  const flow = engine.flowView().flows.find(item => item.id === 'demo')
  const route = flow?.nodes.find(node => node.id === 'route')
  return (route?.out ?? []).map(edge => ({ to: edge.to, ...(edge.when === undefined ? {} : { when: edge.when }) }))
}

describe('挪分支顺序', () => {
  it('往上挪把这条边提到兜底前面：从「永远走不到」变成第一条判的', async () => {
    const engine = await boot()
    expect(routeOut(engine).map(edge => edge.to)).toEqual(['call-a', 'call-b', 'call-c'])

    const result = await engine.moveFlowEdge({ from: 'route', index: 2, direction: 'up' })
    expect(result.ok).toBe(true)

    const out = routeOut(engine)
    expect(out.map(edge => edge.to)).toEqual(['call-a', 'call-c', 'call-b'])
    // 条件跟着走：`call-c` 那条的 when 不会被丢掉，也不会串到 `call-b` 上。
    expect(out[1]?.when).toEqual([{ kind: 'from', any: ['c@example.com'] }])
    expect(out[2]?.when).toBeUndefined()
    engine.stop()
  })

  it('落盘：挪完的文件里顺序真的变了', async () => {
    const engine = await boot()
    await engine.moveFlowEdge({ from: 'route', index: 0, direction: 'down' })
    engine.stop()

    const raw = readFileSync(join(home, 'events', 'demo.yml'), 'utf8')
    const a = raw.indexOf('to: call-b')
    const b = raw.indexOf('to: call-a')
    expect(b).toBeGreaterThan(-1)
    expect(a).toBeGreaterThan(-1)
    // 往下挪之后 `call-b`（原第 2 条，兜底）排到了 `call-a` 前面。
    expect(a).toBeLessThan(b)
  })

  it('到头了就说清楚，不乱动文件', async () => {
    const engine = await boot()
    const up = await engine.moveFlowEdge({ from: 'route', index: 0, direction: 'up' })
    expect(up.ok).toBe(false)
    expect(up.message).toBe('已经是第一条了')

    const down = await engine.moveFlowEdge({ from: 'route', index: 2, direction: 'down' })
    expect(down.ok).toBe(false)
    expect(down.message).toBe('已经是最后一条了')

    expect(routeOut(engine).map(edge => edge.to)).toEqual(['call-a', 'call-b', 'call-c'])
    engine.stop()
  })
})
