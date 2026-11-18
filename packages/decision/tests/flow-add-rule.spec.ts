/**
 * 新建一条规则：边、条件、子工作流一起落盘。
 *
 * 守的是一条**可达性**约定：分支按顺序判、第一条命中的生效，所以新建的规则必须排在
 * 第一个无条件边（兜底）**之前**——追加到兜底后面等于「永远不会命中」，界面上刚建完
 * 就会弹「第 N 条是无条件兜底，它后面还有 1 条」。
 *
 * @module @free-dsh-plugins/dsh-decision/tests/flow-add-rule
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskEngine } from '../src/task/engine.ts'
import type { TaskConnector } from '../src/task/connector.ts'

/** 条件/动作的收窄：这里只要能过一遍，形状由各连接器负责。 */
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

/** 一个只有触发器的假连接器。 */
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

/** 一条带条件的边 + 一条兜底：新规则必须插在兜底前面。 */
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
  '              - x@example.com',
  '      - to: end',
  '  - id: call-a',
  '    type: mark',
  '    out: [{ to: end }]',
  '  - id: end',
  '    type: end',
  '',
].join('\n')

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-rule-'))
  mkdirSync(join(home, 'events'), { recursive: true })
  writeFileSync(join(home, 'events', 'demo.yml'), FLOW, 'utf8')
})

afterEach(() => {
  // Windows 上引擎可能还攥着文件句柄，删不掉就算了（临时目录）。
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch { /* 留下也无妨 */ }
})

/** 起引擎并读一遍规则。 */
async function boot() {
  const engine = new TaskEngine({ home })
  engine.register(connector())
  await engine.start()
  return engine
}

/** `route` 现在有几条出边、各自指向哪儿。 */
function routeOut(engine: TaskEngine): { to: string; when?: readonly unknown[] }[] {
  const flow = engine.flowView().flows.find(item => item.id === 'demo')
  const route = flow?.nodes.find(node => node.id === 'route')
  return (route?.out ?? []).map(edge => ({ to: edge.to, ...(edge.when === undefined ? {} : { when: edge.when }) }))
}

describe('新建规则', () => {
  it('插在兜底边之前，不会刚建就永远不命中', async () => {
    const engine = await boot()
    const result = await engine.addRule({
      flowId: 'demo',
      from: 'route',
      name: 'probe-rule',
      when: [{ kind: 'from', any: ['probe@example.com'] }],
    })
    expect(result.ok).toBe(true)
    // 兜底原本是第 2 条（index 1）：新规则顶到它前面。
    expect(result.edgeIndex).toBe(1)

    const out = routeOut(engine)
    expect(out.map(edge => edge.to)).toEqual(['call-a', 'call-probe-rule', 'end'])
    // 条件跟着边一起写进去了，不是建完再补。
    expect(out[1]?.when).toEqual([{ kind: 'from', any: ['probe@example.com'] }])
    engine.stop()
  })

  it('新建的子工作流先放一个结束节点，方便接着编排', async () => {
    const engine = await boot()
    await engine.addRule({
      flowId: 'demo',
      from: 'route',
      name: 'probe-rule',
      when: [{ kind: 'from', any: ['probe@example.com'] }],
    })
    const workflow = readFileSync(join(home, 'workflows', 'probe-rule.yml'), 'utf8')
    expect(workflow).toContain('id: probe-rule')
    expect(workflow).toContain('type: end')
    engine.stop()
  })
})

describe('中文名生成短 id', () => {
  it('规则名是中文时给 rule-1，不是一串时间戳', async () => {
    const engine = await boot()
    const result = await engine.addRule({ flowId: 'demo', from: 'route', name: '推广邮件归档' })
    expect(result.ok).toBe(true)
    // 挂在事件流上的节点叫 `call-rule-1`，在画布上一眼认得出；时间戳版本读不出来。
    expect(result.nodeId).toBe('call-rule-1')
    engine.stop()
  })
})

describe('新建独立子工作流', () => {
  it('不挂事件也能建：文件里是 开始 → 结束，名字转成 id', async () => {
    const engine = await boot()
    const result = await engine.addWorkflow({ name: 'Promo Guard' })
    expect(result.ok).toBe(true)
    expect(result.flowId).toBe('promo-guard')

    const text = readFileSync(join(home, 'workflows', 'promo-guard.yml'), 'utf8')
    // 文件头注释要和手写文件一致：# 后面有一个空格。
    expect(text.split('\n')[0]).toMatch(/^# /)
    expect(text).toContain('id: promo-guard')
    expect(text).toContain('name: Promo Guard')
    expect(text).toContain('type: start')
    expect(text).toContain('to: end')
    engine.stop()
  })

  it('中文名转不出 slug 也能建，撞名自动加序号', async () => {
    const engine = await boot()
    const first = await engine.addWorkflow({ name: '退订邮件归档' })
    expect(first.ok).toBe(true)
    // 中文转不成 slug：退回 `flow-1`，短得能在画布上读出来（时间戳没人认得出）。
    expect(first.flowId).toBe('flow-1')

    const same = await engine.addWorkflow({ name: 'promo' })
    const again = await engine.addWorkflow({ name: 'promo' })
    expect(same.flowId).toBe('promo')
    expect(again.flowId).toBe('promo-2')
    engine.stop()
  })
})