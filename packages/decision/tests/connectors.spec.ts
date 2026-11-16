/**
 * 连接器开关：关掉一个连接器只停它的规则参与，不卸载它。
 *
 * 这一层钉住的是「关掉之后事件真的没人接」，以及开关会落盘——只关在内存里的话，
 * 重启一次配置就悄悄回来了，而用户以为自己已经关过了。
 *
 * @module @free-lzj/dsh-decision/tests/connectors
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine, OwnedRegistry, defineAction } from '../src/task/index.ts'
import type {
  ActionNode, ActionSpecLike, Condition, ConditionSpecLike, TaskConnector, TaskContext, TaskTrigger,
} from '../src/task/index.ts'
import type { DecisionConfigBase } from '../src/config.ts'

const baseConfig: DecisionConfigBase = {
  enabled: true,
  dryRun: false,
  undoWindowSeconds: 0,
  runHistoryLimit: 500,
  runRetentionDays: 30,
}

/** 一个只有一个触发器的连接器。 */
function connectorOf(id: string): TaskConnector {
  const trigger: TaskTrigger = {
    kind: 'trigger',
    id: `${id}:new`,
    connector: id,
    listensTo: [`${id}.received`],
    async run() {
      return { status: 'continue', ok: true, detail: '收到', seed: { key: `${id}:1`, title: `${id} 事件` } }
    },
  }
  return {
    id,
    label: id,
    directions: ['in'],
    implemented: true,
    triggers: [trigger],
    actions: [],
    vocabulary: {
      normalizeCondition: () => undefined,
      normalizeAction: (input: unknown): ActionSpecLike | undefined => {
        if (typeof input !== 'object' || input === null) return undefined
        const kind = (input as Record<string, unknown>)['kind']
        return typeof kind === 'string' ? { kind } : undefined
      },
    },
    defaultRules: 'version: 1\nrules: []\n',
  }
}

/** 造一台装好两个连接器的引擎。 */
async function harness(): Promise<{ engine: TaskEngine; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-connectors-'))
  const engine = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
  engine.register(connectorOf('a'))
  engine.register(connectorOf('b'))
  await engine.start()
  return { engine, home }
}

/** 发一条属于某个连接器的事件。 */
function eventOf(id: string) {
  return { type: `${id}.received`, source: id, payload: {} }
}

describe('连接器开关', () => {
  it('默认参与规则：事件能建出任务', async () => {
    const { engine } = await harness()
    const ack = await engine.emit(eventOf('a'))
    await engine.flush()
    expect(ack.handled).toBe(true)
    expect(engine.view().tasks).toHaveLength(1)
    engine.stop()
  })

  it('关掉以后，它的事件没人接；另一个连接器不受影响', async () => {
    const { engine } = await harness()
    expect(await engine.setConnectorEnabled('a', false)).toEqual({ ok: true })
    const ack = await engine.emit(eventOf('a'))
    const other = await engine.emit(eventOf('b'))
    await engine.flush()
    expect(ack.handled).toBe(false)
    expect(other.handled).toBe(true)
    expect(engine.view().tasks).toHaveLength(1)
    engine.stop()
  })

  it('再打开就恢复', async () => {
    const { engine } = await harness()
    await engine.setConnectorEnabled('a', false)
    await engine.setConnectorEnabled('a', true)
    expect((await engine.emit(eventOf('a'))).handled).toBe(true)
    engine.stop()
  })

  it('开关落盘：换了引擎还是关着的', async () => {
    const { home } = await harness()
    const first = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
    first.register(connectorOf('a'))
    await first.start()
    await first.setConnectorEnabled('a', false)
    first.stop()

    const second = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
    second.register(connectorOf('a'))
    await second.start()
    expect(second.view().connectors[0]?.enabled).toBe(false)
    expect((await second.emit(eventOf('a'))).handled).toBe(false)
    second.stop()
  })

  it('连接器页读得到它带来什么：触发器和动作 kind', async () => {
    const { engine } = await harness()
    const info = engine.view().connectors.find(connector => connector.id === 'a')
    expect(info?.triggers).toEqual(['a:new'])
    expect(info?.enabled).toBe(true)
    engine.stop()
  })

  it('不认识的 id 如实失败', async () => {
    const { engine } = await harness()
    expect((await engine.setConnectorEnabled('nope', false)).ok).toBe(false)
    engine.stop()
  })
})

/* ────────────────────────── 全局兜底（connector: '*'） ────────────────────────── */

/** 一个能"命中/落空"、并且带一个记录动作的连接器。 */
function judgingConnector(input: {
  readonly id: string
  readonly hits: boolean
  readonly calls: Record<string, string>[]
  readonly rules?: string
}): TaskConnector {
  const kind = `${input.id}:self`
  const conditions = new OwnedRegistry<Condition<ConditionSpecLike, unknown, string>>()
  conditions.register(input.id, {
    kind,
    needsBody: false,
    test: () => input.hits,
  })
  const note: ActionNode<ActionSpecLike, TaskContext> = defineAction({
    kind: `${input.id}:note`,
    sideEffect: false,
    async run(_spec, context) {
      input.calls.push({ ...context.vars })
      return { ok: true, detail: '已提醒' }
    },
  })
  return {
    id: input.id,
    label: input.id === 'a' ? '甲' : '乙',
    directions: ['in'],
    implemented: true,
    triggers: [{
      kind: 'trigger',
      id: `${input.id}:new`,
      connector: input.id,
      listensTo: [`${input.id}.received`],
      async run() {
        return { status: 'continue', ok: true, detail: '收到', seed: { key: `${input.id}:1`, title: '某事发生了' } }
      },
    }],
    actions: [note],
    judge: {
      conditions: conditions as never,
      plan: () => ({ context: () => ({}), readBody: async () => '' }),
    },
    vocabulary: {
      normalizeCondition: (value: unknown): ConditionSpecLike | undefined => {
        if (typeof value !== 'object' || value === null) return undefined
        return (value as Record<string, unknown>)['kind'] === kind ? { kind } : undefined
      },
      normalizeAction: (value: unknown): ActionSpecLike | undefined => {
        if (typeof value !== 'object' || value === null) return undefined
        const found = (value as Record<string, unknown>)['kind']
        return found === `${input.id}:note` ? { kind: `${input.id}:note` } : undefined
      },
    },
    defaultRules: input.rules ?? 'version: 1\nrules: []\n',
  }
}

/** 造一台只装了甲的引擎（甲带规则、乙只提供兜底动作）。 */
async function globalHarness(input: {
  readonly hits: boolean
  readonly rules: string
  readonly calls: Record<string, string>[]
}): Promise<TaskEngine> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-global-'))
  const engine = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
  engine.register(judgingConnector({ id: 'a', hits: input.hits, calls: input.calls, rules: input.rules }))
  engine.register(judgingConnector({ id: 'b', hits: true, calls: input.calls }))
  await engine.start()
  return engine
}

/** 一条专属规则 + 一条全局兜底。 */

describe('全局兜底（connector: *）', () => {
  it('没写归属的规则永不执行，并且数得出来', async () => {
    const calls: Record<string, string>[] = []
    const rules = 'version: 1\nrules:\n  - name: 忘了写归属\n    when: []\n    then:\n      - kind: a:note\n'
    const engine = await globalHarness({ hits: false, rules, calls })
    await engine.emit({ type: 'a.received', source: 'a', payload: {} })
    await engine.flush()
    expect(calls).toHaveLength(0)
    expect(engine.rules().unassigned).toBe(1)
    engine.stop()
  })
})
