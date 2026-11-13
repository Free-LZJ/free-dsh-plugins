/**
 * 任务核心的行为：一个事件一个任务、首命中、五分支、迁移与注册冲突。
 *
 * 用假连接器驱动，不碰任何真实连接器——核心的契约正是「不认识任何来源」，所以
 * 这些断言就是它该守住的全部。
 *
 * @module @free-lzj/dsh-decision/tests/task
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnedRegistry, TaskEngine, defineAction } from '../src/task/index.ts'
import type {
  ActionNode, ActionSpecLike, ClassifyOutcome, Condition, ConditionSpecLike, TaskConnector,
  TaskContext, TaskEvent, TaskTrigger, TriggerOutcome,
} from '../src/task/index.ts'
import type { DecisionConfigBase } from '../src/config.ts'

/* ─────────────────────────────── 假件 ─────────────────────────────── */

/** 一个可变时钟，让节点时间严格递增。 */
function clock(start = Date.parse('2026-11-10T00:00:00.000Z')): { now: () => Date } {
  let current = start
  return {
    now: () => {
      current += 1000
      return new Date(current)
    },
  }
}

const baseConfig: DecisionConfigBase = {
  enabled: true,
  dryRun: false,
  undoWindowSeconds: 0,
  runHistoryLimit: 500,
  runRetentionDays: 30,
}

/** 一条只认 `c:*` 条件的词表。 */
interface FakeConditionSpec extends ConditionSpecLike {
  readonly label?: string
}

function vocabularyOf(kinds: readonly string[]) {
  return {
    normalizeCondition(input: unknown): FakeConditionSpec | undefined {
      if (typeof input !== 'object' || input === null) return undefined
      const record = input as Record<string, unknown>
      if (record['kind'] === 'c:always') return { kind: 'c:always' }
      if (record['kind'] === 'c:label') {
        return { kind: 'c:label', label: typeof record['label'] === 'string' ? record['label'] : '' }
      }
      return undefined
    },
    normalizeAction(input: unknown): ActionSpecLike | undefined {
      if (typeof input !== 'object' || input === null) return undefined
      const record = input as Record<string, unknown>
      if (typeof record['kind'] !== 'string' || !kinds.includes(record['kind'])) return undefined
      const mode = record['mode']
      return {
        kind: record['kind'],
        ...(mode === 'auto' || mode === 'suggest' || mode === 'off' ? { mode } : {}),
      }
    },
  }
}

/** 一个默认接下的触发器。 */
function triggerOf(input: {
  readonly id?: string
  readonly priority?: number
  readonly match?: (event: TaskEvent) => boolean
  readonly decline?: boolean
} = {}): TaskTrigger {
  return {
    kind: 'trigger',
    id: input.id ?? 'fake:new',
    connector: 'fake',
    listensTo: ['fake.received'],
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.match === undefined ? {} : { match: input.match }),
    async run(event: TaskEvent): Promise<TriggerOutcome> {
      if (input.decline === true) return { status: 'stop', ok: true, detail: '不接' }
      const payload = event.payload as { id?: string }
      const ticket = payload.id ?? 'one'
      return {
        status: 'continue',
        ok: true,
        detail: `收到 ${event.type}`,
        seed: { key: `fake:${ticket}`, title: `事件 ${ticket}` },
      }
    },
  }
}

/** `always` 条件。 */
const alwaysCondition: Condition<FakeConditionSpec, unknown, string> = {
  kind: 'c:always',
  needsBody: false,
  test: () => true,
}

/** 分类标签条件：从匹配上下文里取已经跑过的分类结果。 */
interface FakeMatchContext {
  readonly classification?: () => Promise<{ readonly label: string; readonly confidence: number }>
}

const labelCondition: Condition<FakeConditionSpec, FakeMatchContext, string> = {
  kind: 'c:label',
  needsBody: false,
  async test(spec, context) {
    const answer = await context.classification?.()
    return answer?.label === spec.label
  },
}

/** 一个记录调用的动作。 */
function actionOf(input: {
  readonly kind: string
  readonly sideEffect?: boolean
  readonly calls: string[]
  readonly fail?: boolean
  readonly sessionId?: string
}): ActionNode<ActionSpecLike, TaskContext> {
  return defineAction({
    kind: input.kind,
    sideEffect: input.sideEffect === true,
    async run(spec, context) {
      input.calls.push(`${context.task.id}:${spec.kind}`)
      if (input.fail === true) return { ok: false, message: '故意失败', failure: 'config' }
      return {
        ok: true,
        detail: `做了 ${spec.kind}`,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId, data: { mode: 'create' } }),
      }
    },
  })
}

/** 造一台引擎 + 一个假连接器。 */
function harness(input: {
  readonly rules?: string
  readonly calls?: string[]
  readonly triggers?: readonly TaskTrigger[]
  readonly actions?: readonly ActionNode<ActionSpecLike, TaskContext>[]
  readonly config?: Partial<DecisionConfigBase>
  readonly classifyLabels?: readonly string[]
} = {}): { engine: TaskEngine; home: string; calls: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-task-'))
  const calls = input.calls ?? []
  const conditions = new OwnedRegistry<Condition<FakeConditionSpec, FakeMatchContext, string>>()
  conditions.register('fake', alwaysCondition)
  conditions.register('fake', labelCondition)
  const connector: TaskConnector = {
    id: 'fake',
    label: '假连接器',
    directions: ['in', 'out'],
    implemented: true,
    triggers: input.triggers ?? [triggerOf()],
    actions: input.actions ?? [
      actionOf({ kind: 'ok', calls }),
      actionOf({ kind: 'side', sideEffect: true, calls }),
      actionOf({ kind: 'boom', calls, fail: true }),
      actionOf({ kind: 'spawn', calls, sessionId: 'session-abc' }),
    ],
    judge: {
      conditions: conditions as never,
      plan: request => ({
        context: () => ({ classification: request.classification }),
        readBody: async () => '',
      }),
    },
    classify: {
      node: {
        kind: 'classify',
        async run(): Promise<ClassifyOutcome> {
          calls.push('classify')
          return { status: 'continue', ok: true, detail: '判为 bug', label: 'bug', confidence: 0.9 }
        },
      },
      plan: rules => (rules.some(rule => rule.when.some(spec => spec.kind === 'c:label'))
        ? { labels: input.classifyLabels ?? ['bug', 'promo'] }
        : undefined),
    },
    ports: {},
    vocabulary: vocabularyOf(['ok', 'side', 'boom', 'spawn']),
    defaultRules: input.rules ?? 'version: 1\nrules: []\n',
  }
  const engine = new TaskEngine({
    home,
    config: () => ({ ...baseConfig, ...input.config }),
    now: clock().now,
    dueIntervalMs: 60_000,
  })
  engine.register(connector)
  return { engine, home, calls }
}

/** 一条规则；默认归属假连接器（没归属的规则不会执行）。 */
function ruleOf(input: {
  readonly name: string
  readonly then: readonly ActionSpecLike[]
  readonly when?: readonly FakeConditionSpec[]
  readonly priority?: number
  readonly stopOnMatch?: boolean
  /** `'*'` 表示全局兜底；默认归给假连接器。 */
  readonly connector?: string
}): string {
  const when = input.when ?? [{ kind: 'c:always' }]
  return [
    `  - name: ${input.name}`,
    `    connector: '${input.connector ?? 'fake'}'`,
    ...(input.priority === undefined ? [] : [`    priority: ${String(input.priority)}`]),
    ...(input.stopOnMatch === undefined ? [] : [`    stopOnMatch: ${String(input.stopOnMatch)}`]),
    '    when:',
    ...when.map(condition => `      - kind: ${condition.kind}${condition.label === undefined ? '' : `\n        label: ${condition.label}`}`),
    '    then:',
    ...input.then.map(action => `      - kind: ${action.kind}`),
  ].join('\n')
}

/** 一份规则文件。 */
function rulesFile(entries: readonly string[]): string {
  return ['version: 1', 'rules:', ...entries].join('\n') + '\n'
}

/* ─────────────────────────────── 断言 ─────────────────────────────── */

describe('emit：一个事件只出一个任务', () => {
  it('首命中即停，第二个触发器不再被问', async () => {
    const seen: string[] = []
    const first: TaskTrigger = {
      ...triggerOf({ id: 'first', priority: 10 }),
      async run(): Promise<TriggerOutcome> {
        seen.push('first')
        return { status: 'continue', ok: true, detail: 'a', seed: { key: 'k1', title: 't' } }
      },
    }
    const second: TaskTrigger = {
      ...triggerOf({ id: 'second', priority: 20 }),
      async run(): Promise<TriggerOutcome> {
        seen.push('second')
        return { status: 'continue', ok: true, detail: 'b', seed: { key: 'k2', title: 'u' } }
      },
    }
    const { engine } = harness({ triggers: [second, first] })
    await engine.start()
    const ack = await engine.emit({ type: 'fake.received', source: 'fake', payload: {} })
    expect(ack).toMatchObject({ handled: true, triggerId: 'first' })
    expect(seen).toEqual(['first'])
    expect(engine.view().tasks).toHaveLength(1)
    engine.stop()
  })

  it('第一个不匹配时由下一个接手', async () => {
    const picky = triggerOf({ id: 'picky', priority: 10, match: () => false })
    const fallback = triggerOf({ id: 'fallback', priority: 100 })
    const { engine } = harness({ triggers: [picky, fallback] })
    await engine.start()
    const ack = await engine.emit({ type: 'fake.received', source: 'fake', payload: {} })
    expect(ack).toMatchObject({ handled: true, triggerId: 'fallback' })
    expect(ack.skipped).toEqual([{ triggerId: 'picky', reason: 'no-match' }])
    engine.stop()
  })

  it('没人订阅时明确回答没接', async () => {
    const { engine } = harness()
    await engine.start()
    const ack = await engine.emit({ type: 'nobody.cares', source: 'fake', payload: {} })
    expect(ack).toEqual({ handled: false, skipped: [] })
    engine.stop()
  })

  it('dedupeKey 命中时不再建第二个任务', async () => {
    const { engine } = harness()
    await engine.start()
    const event = { type: 'fake.received', source: 'fake', payload: { id: 'x' }, dedupeKey: 'mail:1:INBOX:7' }
    const first = await engine.emit(event)
    const second = await engine.emit(event)
    expect(first.handled).toBe(true)
    expect(second).toMatchObject({ handled: true, duplicate: true, taskId: first.taskId })
    expect(engine.view().tasks).toHaveLength(1)
    engine.stop()
  })

  it('同一个 key 的第二个事件追加到同一条链', async () => {
    const { engine } = harness()
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'same' } })
    await engine.flush()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'same' }, dedupeKey: 'second' })
    await engine.flush()
    const tasks = engine.view().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.nodes.filter(node => node.kind === 'trigger')).toHaveLength(2)
    engine.stop()
  })
})

describe('规则层：首命中与 stopOnMatch', () => {
  it('两条规则都匹配时只跑第一条的 then', async () => {
    const calls: string[] = []
    const { engine } = harness({
      calls,
      rules: rulesFile([
        ruleOf({ name: 'first', priority: 10, then: [{ kind: 'ok' }] }),
        ruleOf({ name: 'second', priority: 20, then: [{ kind: 'side' }] }),
      ]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'a' } })
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.nodes.filter(node => node.kind === 'rule')).toHaveLength(1)
    expect(calls.map(call => call.split(':')[1])).toEqual(['ok'])
    engine.stop()
  })

  it('stopOnMatch: false 时后续命中的 then 按顺序追加', async () => {
    const calls: string[] = []
    const { engine } = harness({
      calls,
      rules: rulesFile([
        ruleOf({ name: 'first', priority: 10, stopOnMatch: false, then: [{ kind: 'ok' }] }),
        ruleOf({ name: 'second', priority: 20, then: [{ kind: 'side' }] }),
      ]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'b' } })
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.nodes.filter(node => node.kind === 'rule')).toHaveLength(2)
    expect(task?.nodes.filter(node => node.kind === 'ok' || node.kind === 'side').map(node => node.kind))
      .toEqual(['ok', 'side'])
    engine.stop()
  })

  it('没有规则命中时任务标 skipped', async () => {
    const { engine } = harness({
      rules: rulesFile([ruleOf({ name: 'never', when: [{ kind: 'c:label', label: 'nope' }], then: [{ kind: 'ok' }] })]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'c' } })
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('skipped')
    expect(task?.nodes.some(node => node.kind === 'ok')).toBe(false)
    engine.stop()
  })
})

describe('动作分支', () => {
  it('dryRun 记「试运行」且不执行', async () => {
    const calls: string[] = []
    const { engine } = harness({
      calls,
      config: { dryRun: true },
      rules: rulesFile([ruleOf({ name: 'r', then: [{ kind: 'side' }] })]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'e' } })
    await engine.flush()
    expect(calls).toEqual([])
    expect(engine.view().tasks[0]?.nodes.some(node => node.detail.startsWith('试运行'))).toBe(true)
    engine.stop()
  })

  it('动作失败不吞掉后面的动作，任务记 partial', async () => {
    const calls: string[] = []
    const { engine } = harness({
      calls,
      rules: rulesFile([ruleOf({ name: 'r', then: [{ kind: 'boom' }, { kind: 'ok' }] })]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'f' } })
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.status).toBe('partial')
    expect(calls.map(call => call.split(':')[1])).toEqual(['boom', 'ok'])
    engine.stop()
  })

  it('带 sessionId 的动作额外长出一个 session 节点', async () => {
    const { engine } = harness({
      rules: rulesFile([ruleOf({ name: 'r', then: [{ kind: 'spawn' }] })]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'g' } })
    await engine.flush()
    const task = engine.view().tasks[0]
    expect(task?.nodes.find(node => node.kind === 'session')).toMatchObject({ sessionId: 'session-abc', ok: true })
    expect(task?.awaitingConfirmation).toBe(true)
    engine.stop()
  })
})

describe('分类阶段', () => {
  it('没有规则用到分类时不跑分类节点', async () => {
    const calls: string[] = []
    const { engine } = harness({ calls, rules: rulesFile([ruleOf({ name: 'r', then: [{ kind: 'ok' }] })]) })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'h' } })
    await engine.flush()
    expect(calls).not.toContain('classify')
    expect(engine.view().tasks[0]?.nodes.some(node => node.kind === 'classify')).toBe(false)
    engine.stop()
  })

  it('规则用到分类时只跑一次，label 交给条件', async () => {
    const calls: string[] = []
    const { engine } = harness({
      calls,
      rules: rulesFile([ruleOf({ name: 'bug', when: [{ kind: 'c:label', label: 'bug' }], then: [{ kind: 'ok' }] })]),
    })
    await engine.start()
    await engine.emit({ type: 'fake.received', source: 'fake', payload: { id: 'i' } })
    await engine.flush()
    expect(calls.filter(call => call === 'classify')).toHaveLength(1)
    const task = engine.view().tasks[0]
    expect(task?.nodes.find(node => node.kind === 'classify')?.data).toMatchObject({ label: 'bug' })
    expect(task?.nodes.some(node => node.kind === 'ok')).toBe(true)
    engine.stop()
  })
})

describe('注册与迁移', () => {
  it('跨连接器同名动作被拒绝，先注册的保留', async () => {
    const { engine } = harness()
    const rival: TaskConnector = {
      id: 'rival',
      label: '对手',
      directions: ['out'],
      implemented: true,
      triggers: [],
      actions: [actionOf({ kind: 'ok', calls: [] })],
      vocabulary: vocabularyOf(['ok']),
      defaultRules: '',
    }
    engine.register(rival)
    const rivalInfo = engine.view().connectors.find(connector => connector.id === 'rival')
    expect(rivalInfo).toBeUndefined()
    engine.stop()
  })

  it('把旧 runs.json 迁成任务', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-task-mig-'))
    writeFileSync(join(home, 'runs.json'), JSON.stringify({
      version: 1,
      runs: [{
        id: 'run-1',
        at: '2026-11-01T00:00:00.000Z',
        ruleId: 'github',
        ruleName: 'GitHub 通知',
        label: 'bug',
        event: { accountId: 'qq', folder: 'INBOX', uid: 7, subject: '工单来了' },
        actions: [{ kind: 'ok', mode: 'auto', ok: true, detail: '做了' }],
        status: 'done',
      }],
    }))
    const engine = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
    engine.register({
      id: 'fake',
      label: '假连接器',
      directions: ['in'],
      implemented: true,
      triggers: [],
      actions: [],
      vocabulary: vocabularyOf([]) as never,
      defaultRules: '',
      migration: {
        path: join(home, 'runs.json'),
        toTask(record) {
          const run = record as {
            id: string
            at: string
            ruleName: string
            event: { subject?: string }
            actions: readonly { kind: string; ok: boolean; detail: string }[]
          }
          return {
            id: run.id,
            connector: 'fake',
            triggerId: 'fake:new',
            key: `run:${run.id}`,
            title: run.event.subject ?? run.id,
            at: run.at,
            updatedAt: run.at,
            status: 'done',
            nodes: [
              { id: 'n1', kind: 'trigger', at: run.at, ok: true, detail: '迁移' },
              { id: 'n2', kind: 'rule', at: run.at, ok: true, detail: run.ruleName },
              ...run.actions.map((action, index) => ({
                id: `n${String(index + 3)}`,
                kind: action.kind,
                at: run.at,
                ok: action.ok,
                detail: action.detail,
              })),
            ],
            event: { type: 'fake.received', source: 'fake', payload: run.event },
            vars: {},
          }
        },
      },
    })
    await engine.start()
    const tasks = engine.view().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('工单来了')
    expect(tasks[0]?.nodes.map(node => node.kind)).toEqual(['trigger', 'rule', 'ok'])
    engine.stop()
  })
})
