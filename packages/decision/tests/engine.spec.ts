/**
 * 引擎的验收：它独占三份状态、只接一个连接器，且没有连接器时是一种**说得出**的状态。
 *
 * 这里不碰 cordis、不碰邮件：连接器是假的（一个「总是命中」的条件 + 一个记账动作），
 * 于是断言的每一条都只关于引擎自己——文件写在哪、规则读回来是什么、队列什么时候
 * 真的执行、撤销是取消还是回滚。
 *
 * @module @free-lzj/dsh-decision/tests/engine
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DecisionEngine, createPendingStore, createRunStore,
  type Action, type ActionSpecLike, type Condition, type ConditionSpecLike, type EngineConnector,
  type EngineOutcome, type EnginePending,
} from '../src/index.ts'

/** 发货默认规则：一条规则、一个动作，注释用来验证写操作不会重排文件。 */
const DEFAULT_RULES = [
  '# 发货默认规则',
  '- id: first',
  '  name: 第一条',
  '  priority: 10',
  '  when:',
  '    - kind: always',
  '  then:',
  '    - kind: mark',
  '',
].join('\n')

/** 这一侧的词表：两个条件无关的字段都不校验，只认 kind。 */
const VOCABULARY: EngineConnector['vocabulary'] = {
  normalizeCondition: input =>
    (typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'always'
      ? { kind: 'always' }
      : undefined),
  normalizeAction: input => {
    const kind = (input as { kind?: unknown } | null)?.kind
    return kind === 'mark' || kind === 'wait' ? { kind } : undefined
  },
}

const ALWAYS: Condition<ConditionSpecLike, unknown> = {
  kind: 'always',
  needsBody: false,
  test: () => true,
}

/** 一次动作执行记一行；`undo` 让「回滚」这条路也能断言。 */
interface Calls {
  readonly lines: string[]
  readonly runs: string[]
}

/**
 * 造一个记账动作。
 * @param calls - 调用记录。
 * @returns 动作实现。
 */
function markAction(calls: Calls): Action<ActionSpecLike, unknown, EngineOutcome> {
  return {
    kind: 'mark',
    sideEffect: true,
    run: async () => {
      calls.runs.push('mark')
      return { ok: true, detail: '标记过了' }
    },
  }
}

/**
 * 造一台引擎和一个连接器。
 * @param tag - 临时目录名里的标记。
 * @param overrides - 要替换的连接器字段。
 * @returns 引擎、连接器与调用记录。
 */
async function harness(tag: string, overrides: Partial<EngineConnector> = {}): Promise<{
  readonly home: string
  readonly engine: DecisionEngine
  readonly connector: EngineConnector
  readonly calls: Calls
  readonly lines: string[]
}> {
  const home = join(await mkdtemp(join(tmpdir(), `decision-engine-${tag}-`)), 'rules')
  const calls: Calls = { lines: [], runs: [] }
  const lines: string[] = []
  let connector: EngineConnector = {
    vocabulary: VOCABULARY,
    defaultRules: DEFAULT_RULES,
    conditions: [ALWAYS],
    actions: [markAction(calls)],
    // 两份记录的形状是连接器的知识；引擎只给路径，仓由连接器建好交进来。
    runs: createRunStore<unknown>({
      path: join(home, 'runs.json'),
      parseEvent: record => (typeof record['id'] === 'string' ? { id: record['id'] } : undefined),
    }),
    pending: createPendingStore<EnginePending>({
      path: join(home, 'pending.json'),
      parse: value => (typeof (value as EnginePending | undefined)?.runId === 'string' ? value as EnginePending : undefined),
    }),
    config: () => ({ enabled: true, dryRun: false, undoWindowSeconds: 0, runHistoryLimit: 100, runRetentionDays: 30 }),
    replayContext: record => ({ record }),
    ...overrides,
    // 引擎的默认到期扫描周期在测试里没有意义：所有到期判定都由用例钉死时间手动驱动。
  }
  const engine = new DecisionEngine({ home, log: line => { lines.push(line) }, warn: line => { lines.push(line) }, dueIntervalMs: 3_600_000 })
  engines.push(engine)
  return { home, engine, connector, calls, lines }
}

const engines: DecisionEngine[] = []

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
})

describe('没有连接器', () => {
  it('是一种说得出、也不写文件的状态', async () => {
    const { home, engine } = await harness('bare')
    await engine.start()

    const view = engine.view()
    expect(view.connector).toBe(false)
    expect(view.rules).toEqual([])
    // 没有连接器就没有默认规则可写：那一步属于知道规则语言的那一侧。
    expect(existsSync(join(home, 'rules.yml'))).toBe(false)
    expect(await engine.test({ accountId: 'a', folder: 'INBOX', uid: 1 })).toMatchObject({ ok: false })
  })
})

describe('接上连接器', () => {
  it('第一次启动写下默认规则，第二次读回文件', async () => {
    const { home, engine, connector, lines } = await harness('default')
    expect(await engine.use(connector)).toBe(true)
    await engine.start()

    const view = engine.view()
    expect(view.connector).toBe(true)
    expect(view.source).toBe('default')
    expect(view.rules.map(rule => rule.id)).toEqual(['first'])
    expect(view.path).toBe(join(home, 'rules.yml'))
    expect(existsSync(view.path)).toBe(true)
    expect(lines.some(line => line.includes('已加载 1 条规则'))).toBe(true)

    engine.stop()
    const second = new DecisionEngine({ home })
    engines.push(second)
    await second.use(connector)
    await second.start()
    expect(second.view().source).toBe('file')
  })

  it('第二个连接器拿不到这台引擎，也不会把词表混在一起', async () => {
    const { engine, connector } = await harness('one-connector')
    expect(await engine.use(connector)).toBe(true)
    const other = { ...connector, defaultRules: DEFAULT_RULES }
    expect(await engine.use(other)).toBe(false)
    // 幂等的重复挂载仍然成立（热重载会再挂一次同一个连接器）。
    expect(await engine.use(connector)).toBe(true)
  })

  it('关掉一条规则就落进文件，注释还在', async () => {
    const { engine, connector } = await harness('toggle')
    await engine.use(connector)
    await engine.start()

    expect(await engine.setEnabled('first', false)).toEqual({ ok: true })
    expect(engine.rules()[0]?.enabled).toBe(false)
    expect(await readFile(engine.rulesPath, 'utf8')).toContain('# 发货默认规则')

    const missing = await engine.setEnabled('nope', false)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('nope')
  })

  it('摘掉连接器之后回到「没有连接器」，规则与文件都还在', async () => {
    const { engine, connector } = await harness('unuse')
    await engine.use(connector)
    await engine.start()
    const path = engine.rulesPath
    engine.unuse()

    expect(engine.view().connector).toBe(false)
    expect(engine.conditions.kinds()).toEqual([])
    expect(engine.actions.kinds()).toEqual([])
    expect(existsSync(path)).toBe(true)
    // 再挂回来就又能读到那份文件。
    expect(await engine.use(connector)).toBe(true)
    await engine.reloadRules()
    expect(engine.rules()).toHaveLength(1)
  })
})

describe('旧目录迁移', () => {
  it('把三份状态搬过来，只搬不删', async () => {
    const { home, engine, connector } = await harness('legacy', { legacyHomes: [] })
    const legacy = join(home, '..', 'old-engine')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'rules.yml'), [
      '- id: mine',
      '  name: 我自己的规则',
      '  when:',
      '    - kind: always',
      '  then:',
      '    - kind: mark',
      '',
    ].join('\n'), 'utf8')

    await engine.use({ ...connector, legacyHomes: [legacy] })
    await engine.start()

    expect(engine.rules().map(rule => rule.id)).toEqual(['mine'])
    expect(engine.view().source).toBe('file')
    expect(existsSync(join(legacy, 'rules.yml'))).toBe(true)
  })
})

describe('撤销与到期执行', () => {
  /** 排一条到期的动作进队列，并给它的记录先占好位。 */
  async function queue(connector: EngineConnector, kind: 'undo' | 'suggest', dueAt: string): Promise<string> {
    const runs = connector.runs
    const pending = connector.pending
    const run = await runs.append({
      at: '2026-01-01T00:00:00.000Z',
      ruleId: 'first',
      ruleName: '第一条',
      label: '第一条',
      event: {},
      actions: [{ kind: 'mark', mode: 'auto', ok: true, detail: '已排队' }],
      status: 'done',
    })
    await pending.add({
      runId: run.id,
      actionIndex: 0,
      action: { kind: 'mark' },
      kind,
      dueAt,
    })
    return run.id
  }

  it('到期的 undo 项真的执行，suggest 项永远等人', async () => {
    const { engine, connector, calls } = await harness('due')
    await engine.use(connector)
    const runId = await queue(connector, 'undo', '2026-01-01T00:00:00.000Z')
    await queue(connector, 'suggest', '2026-01-01T00:00:00.000Z')

    expect(await engine.runDue(new Date('2030-01-01T00:00:00.000Z'))).toBe(1)
    expect(calls.runs).toEqual(['mark'])
    // 建议还在队列里：它不按时间失效。
    expect(connector.pending.list()).toHaveLength(1)
    expect(connector.pending.list()[0]?.kind).toBe('suggest')
    // 记录被就地回填，而不是追加一条新的。
    expect(connector.runs.get(runId)?.actions[0]).toMatchObject({ ok: true, detail: '标记过了' })
    expect(connector.runs.list()).toHaveLength(2)
  })

  it('撤销窗口内的项是被取消，而不是回滚', async () => {
    const { engine, connector, calls } = await harness('undo-cancel')
    await engine.use(connector)
    const runId = await queue(connector, 'undo', '2099-01-01T00:00:00.000Z')

    const result = await engine.undo(runId)
    expect(result.ok).toBe(true)
    expect(connector.pending.list()).toHaveLength(0)
    expect(calls.runs).toEqual([])
    expect(connector.runs.get(runId)?.status).toBe('undone')
  })

  it('已经执行过的动作走回滚闭包，而且可以重复登记', async () => {
    const { engine, connector } = await harness('undo-rollback')
    await engine.use(connector)
    const runId = await queue(connector, 'undo', '2026-01-01T00:00:00.000Z')
    const reversed: string[] = []
    engine.registerUndo(runId, async () => { reversed.push('one') })
    engine.registerUndo(runId, async () => { reversed.push('two') })

    expect((await engine.undo(runId)).ok).toBe(true)
    // 逆序：同一个对象上的两个动作，正序回滚会把第二个的结果当成第一个的。
    expect(reversed).toEqual(['two', 'one'])
  })

  it('撤销找不到的记录时说明原因', async () => {
    const { engine, connector } = await harness('undo-missing')
    await engine.use(connector)
    const result = await engine.undo('run-nope')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('run-nope')
  })
})
