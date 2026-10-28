/**
 * The board: the whole flow, from an event to a finished card.
 *
 * These tests drive the real pipeline — classify, route, dispatch, run,
 * finish — with the simulated executor at zero delay, so the chain is the
 * one the page exercises, not a stub of it. What they pin, besides the happy
 * path: dedupe, the human overflow pool, the manual paths, and the two
 * boundaries v0 keeps — no write-back, and no executor id routing names but
 * nobody registered.
 *
 * @module @free-lzj/dsh-console/tests/workbench/board
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoutingTable } from '../../src/workbench/routing.ts'
import { WorkbenchBoard } from '../../src/workbench/board.ts'
import { ClassifierRegistry, RuleClassifier } from '../../src/workbench/classifier.ts'
import { builtinConnectors, ConnectorRegistry } from '../../src/workbench/connectors.ts'
import { ExecutorRegistry, SimulatedExecutor } from '../../src/workbench/executors.ts'
import { defaultRoutingTable, RoutingTableStore } from '../../src/workbench/routing.ts'

/** Homes created by one test, removed afterwards. */
const homes: string[] = []

afterEach(async () => {
  // 看板的写是异步的：测试结束时可能还有一次补写在路上，删目录要容忍这种竞态。
  for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

/** @returns a fresh directory this test owns. */
async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-console-board-'))
  homes.push(directory)
  return directory
}

/** Build a board over fresh registries, with the simulated executor at zero delay. */
function bench(options: {
  homeDir?: string
  table?: RoutingTable
  enabled?: readonly string[]
  /** 额外注册的执行器，用来演「跑到一半就失败」这种真实分支。 */
  addExecutor?: (registry: ExecutorRegistry) => void
} = {}) {
  const classifiers = new ClassifierRegistry()
  classifiers.register(new RuleClassifier())
  const executors = new ExecutorRegistry()
  executors.register(new SimulatedExecutor('dsh', 'DSH（模拟）', 0))
  executors.register(new SimulatedExecutor('codex', 'Codex（模拟）', 0))
  options.addExecutor?.(executors)
  const connectors = new ConnectorRegistry()
  for (const connector of builtinConnectors()) connectors.register(connector)
  const warned: string[] = []
  const routing = new RoutingTableStore(undefined, options.table ?? defaultRoutingTable(), (line) => warned.push(line))
  const board = new WorkbenchBoard({
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    classifiers,
    executors,
    connectors,
    routing,
    enabledConnectors: () => options.enabled ?? ['mail', 'webhook'],
    classifierId: () => 'rule',
    warn: (line) => warned.push(line),
  })
  return { board, warned }
}

/**
 * Poll until a condition holds.
 * @param check - the condition.
 * @param label - what the wait is for, named in the timeout.
 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ingest', () => {
  it('dispatches a confident bug and finishes it awaiting confirmation', async () => {
    const { board } = bench()
    const result = await board.ingest({ source: 'webhook', title: '线上服务崩溃，无法打开' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.card.column).toBe('processing')
    expect(result.card.sessionId).toBeDefined()
    expect(result.decision).toMatchObject({ action: 'dispatch', executor: 'dsh' })
    await waitFor(() => {
      const card = board.state().cards[0]
      return card?.column === 'done' && card.awaitingConfirmation === true
    }, 'the card to finish')
    const session = board.state().sessions[0]
    expect(session?.status).toBe('done')
    expect(session?.logs.map((line) => line.text).join('\n')).toContain('处理完成，结果待用户确认')
  })

  it('holds an unclassifiable event in todo, with no session', async () => {
    const { board } = bench()
    const result = await board.ingest({ source: 'mail', title: '今天天气不错' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.card.column).toBe('todo')
    expect(result.card.sessionId).toBeUndefined()
    expect(result.decision).toMatchObject({ action: 'hold', routeId: 'low-confidence' })
    expect(board.state().sessions).toEqual([])
  })

  it('dedupes a repeated delivery instead of building a second card', async () => {
    const { board } = bench()
    const first = await board.ingest({ source: 'jira', externalId: 'EXEPD-1', title: '页面报错' })
    const second = await board.ingest({ source: 'jira', externalId: 'EXEPD-1', title: '页面报错' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.duplicate).toBe(true)
    expect(board.state().cards).toHaveLength(1)
  })

  it('refuses an event without a title', async () => {
    const { board } = bench()
    const result = await board.ingest({ source: 'webhook', title: '   ' })
    expect(result.ok).toBe(false)
  })

  it('holds, with a reason, when routing names an executor nobody registered', async () => {
    const table: RoutingTable = {
      version: 'test',
      rules: [{ id: 'bug-to-ghost', kinds: ['bug'], action: 'dispatch', executor: 'ghost' }],
    }
    const { board } = bench({ table })
    const result = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.card.column).toBe('todo')
    expect(result.decision.routeId).toBe('unknown-executor')
    expect(board.state().sessions).toEqual([])
  })
})

describe('manual dispatch and session control', () => {
  it('dispatches a held card on demand', async () => {
    const { board } = bench()
    const ingested = await board.ingest({ source: 'mail', title: '今天天气不错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return
    const dispatched = board.dispatch(ingested.card.id)
    expect(dispatched.ok).toBe(true)
    expect(dispatched.card?.column).toBe('processing')
    expect(dispatched.session).toBeDefined()
    await waitFor(() => board.state().cards[0]?.column === 'done', 'the manual run to finish')
  })

  it('pauses, resumes, interrupts, and ends a session', async () => {
    const { board } = bench()
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok || ingested.card.sessionId === undefined) return
    const sessionId = ingested.card.sessionId
    expect(board.pauseSession(sessionId).ok).toBe(true)
    expect(board.state().sessions[0]?.status).toBe('paused')
    expect(board.state().cards[0]?.status).toBe('paused')
    expect(board.resumeSession(sessionId).ok).toBe(true)
    expect(board.state().sessions[0]?.status).toBe('running')
    expect(board.interrupt(sessionId, '先别动那一行').ok).toBe(true)
    expect(board.state().sessions[0]?.logs.map((line) => line.text)).toContain('用户插话：先别动那一行')
    expect(board.endSession(sessionId).ok).toBe(true)
    expect(board.state().sessions[0]?.status).toBe('ended')
    expect(board.state().cards[0]?.column).toBe('todo')
  })

  it('moves a card to done by ending its session', async () => {
    const { board } = bench()
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return
    const moved = board.move(ingested.card.id, 'done')
    expect(moved.ok).toBe(true)
    expect(moved.card).toMatchObject({ column: 'done', status: 'done', awaitingConfirmation: true })
    expect(board.state().sessions[0]?.status).toBe('ended')
  })

  it('builds one card when the same event is delivered twice at once', async () => {
    // 去重表是在分类**之后**才写的，所以两次投递如果都落在那段 await 里，两次都会
    // 看到「没见过」。先占位再分类是这件事的全部修法。
    const { board } = bench()
    const event = { source: 'webhook' as const, title: '同一个事件', externalId: 'evt-1' }
    const [first, second] = await Promise.all([board.ingest(event), board.ingest(event)])
    expect(first.ok && second.ok).toBe(true)
    expect(board.state().cards).toHaveLength(1)
    // 第二封明确回答「是重复」，让调用方知道它没有新建任何东西。
    expect(second.ok && second.duplicate).toBe(true)
  })

  it('reuses a paused session instead of starting a second run', async () => {
    // 派单会覆盖 card.sessionId；不先确认旧会话，旧的那条就永远没人收尾。
    const { board } = bench()
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok || ingested.card.sessionId === undefined) return
    const first = ingested.card.sessionId
    expect(board.pauseSession(first).ok).toBe(true)
    expect(board.move(ingested.card.id, 'todo').ok).toBe(true)
    const again = board.dispatch(ingested.card.id)
    expect(again.ok).toBe(true)
    if (!again.ok || again.card === undefined) return
    expect(again.card.sessionId).toBe(first)
    expect(board.state().sessions).toHaveLength(1)
    expect(board.state().sessions[0]?.status).toBe('running')
  })

  it('leaves a failed run idle when it goes back to todo, not "paused"', async () => {
    // 一个必然是死状态的卡片不应该自称「已暂停」：那等于承诺一次不会发生的恢复。
    const { board } = bench({
      addExecutor: (registry) => {
        registry.register({
          id: 'boom',
          label: '必然失败',
          dispatch: (_card, sink) => {
            sink.finish('failed')
            return { pause: () => undefined, resume: () => undefined, end: () => undefined, interrupt: () => undefined }
          },
        })
      },
    })
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return
    // 先把默认那次运行收尾（卡片回到待办），再派给必然失败的执行器。
    if (ingested.card.sessionId !== undefined) expect(board.endSession(ingested.card.sessionId).ok).toBe(true)
    const dispatched = board.dispatch(ingested.card.id, 'boom')
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    expect(board.state().cards[0]?.status).toBe('failed')
    // 失败**自己退回待处理**：留在 processing 的话 `dispatch` 会直接早退，卡片既不能
    // 重试也不能再派，界面还写着「进行中」。
    expect(board.state().cards[0]?.column).toBe('todo')
    // 再派单能重来：先收掉那条死掉的会话，再开新的。
    const retried = board.dispatch(ingested.card.id, 'boom')
    expect(retried.ok).toBe(true)
    expect(board.state().sessions.filter((session) => session.status === 'failed')).toHaveLength(1)
  })

  it('clears the write-back flag only when a finished card is confirmed', async () => {
    // `awaitingConfirmation` 只在运行结束时被写上；没有这个动作它就是单向状态，
    // 卡片永远挂着「待确认」。确认是人的声明（出站系统还没接），所以要一次点击。
    const { board } = bench()
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return
    // 未完成的卡片不能确认。
    expect(board.confirm(ingested.card.id)).toEqual({ ok: false, error: 'only a finished card can be confirmed' })
    const done = board.move(ingested.card.id, 'done')
    expect(done.ok).toBe(true)
    if (!done.ok || done.card === undefined) return
    expect(done.card.awaitingConfirmation).toBe(true)
    const confirmed = board.confirm(ingested.card.id)
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok || confirmed.card === undefined) return
    expect(confirmed.card.awaitingConfirmation).toBe(false)
    // 再点一次是幂等的，不是错误。
    expect(board.confirm(ingested.card.id).ok).toBe(true)
  })

  it('refuses unknown cards and sessions', () => {
    const { board } = bench()
    expect(board.dispatch('nope').ok).toBe(false)
    expect(board.move('nope', 'done').ok).toBe(false)
    expect(board.interrupt('nope', 'hi').ok).toBe(false)
    expect(board.pauseSession('nope').ok).toBe(false)
    expect(board.endSession('nope').ok).toBe(false)
  })
})

describe('connectors and persistence', () => {
  it('lists the executors this deployment actually registered', async () => {
    // 页面要能区分「还没接」和「接了但坏了」：路由表指着一个不存在的执行器，
    // 用户看得到名单才知道那是配置问题而不是点坏了。
    const { board } = bench()
    expect(board.state().executors.map((executor) => executor.id).sort()).toEqual(['codex', 'dsh'])
    expect(board.state().executors.find((executor) => executor.id === 'dsh')?.label).toBe('DSH（模拟）')
  })

  it('lists connectors joined with the configuration, dropping unknown ids with a warning', () => {
    const { board, warned } = bench({ enabled: ['mail', 'nope'] })
    const connectors = board.state().connectors
    expect(connectors.find((entry) => entry.id === 'mail')).toMatchObject({ enabled: true, implemented: true })
    expect(connectors.find((entry) => entry.id === 'dingtalk')).toMatchObject({ enabled: false, implemented: false })
    expect(connectors.find((entry) => entry.id === 'nope')).toBeUndefined()
    expect(warned.join('\n')).toContain('unknown connector "nope"')
  })

  it('lands the newest document after a burst of writes', async () => {
    // 写合并之后，一串日志只会产生「一次写 + 一次补写」；这里钉的是**最终落盘的是最新
    // 那份**，而不是写了几次（次数是性能指标，正确性指标是文件内容）。
    const directory = await home()
    const { board } = bench({ homeDir: directory })
    const ingested = await board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok || ingested.card.sessionId === undefined) return
    const sessionId = ingested.card.sessionId
    for (let index = 0; index < 20; index += 1) board.interrupt(sessionId, `第 ${String(index)} 条`)
    await board.flush()

    const reopened = bench({ homeDir: directory })
    await reopened.board.ready
    expect(reopened.board.state().sessions[0]?.logs.map((line) => line.text)).toContain('用户插话：第 19 条')
  })

  it('brings a card that was processing back to todo, not a fake "running"', async () => {
    // 重启之后没有任何运行还活着（handle 随进程消失）。卡片如果照原样读回
    // processing，界面会说它在跑，而派单对 processing 又早退——那正是「重启僵尸卡」。
    const directory = await home()
    const first = bench({ homeDir: directory })
    const ingested = await first.board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok || ingested.card.sessionId === undefined) return
    // 让运行停在「暂停」上，这样落盘的就是一张停在 processing 的卡。
    expect(first.board.pauseSession(ingested.card.sessionId).ok).toBe(true)
    await first.board.flush()

    const reopened = bench({ homeDir: directory })
    await reopened.board.ready
    const card = reopened.board.state().cards[0]
    expect(card?.column).toBe('todo')
    // 会话还在，所以「已暂停」是诚实的说法；但它没有 handle，恢复不了。
    expect(card?.status).toBe('paused')
    const again = reopened.board.dispatch(card?.id ?? '', 'dsh')
    expect(again.ok).toBe(true)
    if (!again.ok || again.card === undefined) return
    expect(again.card.column).toBe('processing')
    // 那条会话的 handle 已经随进程消失，所以派单必须开新的，而不是假装恢复。
    expect(again.card.sessionId).not.toBe(card?.sessionId)
    expect(reopened.board.state().sessions.some((session) => session.status === 'paused')).toBe(false)
    await reopened.board.flush()
  })
  it('reloads cards and finished sessions from the persisted document', async () => {
    const directory = await home()
    const first = bench({ homeDir: directory })
    await first.board.ready
    const ingested = await first.board.ingest({ source: 'webhook', title: '页面报错' })
    expect(ingested.ok).toBe(true)
    await waitFor(() => first.board.state().cards[0]?.column === 'done', 'the run to finish')
    // The write happens on the bump; drain the queue so the reload reads the
    // latest document rather than a write still in flight.
    await first.board.flush()
    const second = bench({ homeDir: directory })
    await second.board.ready
    expect(second.board.state().cards).toHaveLength(1)
    expect(second.board.state().cards[0]).toMatchObject({ column: 'done', awaitingConfirmation: true })
    expect(second.board.state().sessions).toHaveLength(1)
    expect(second.board.state().sessions[0]?.status).toBe('done')
  })

  it('pushes the restored board to subscribers once the read finishes', async () => {
    // 重启后页面常常在读盘完成之前就问过一次（拿到 revision 0 的空板），之后带
    // `since=0` 轮询。若读盘完成不推进 revision、也不推送，那次轮询会被判成
    // 「没变」，看板就永远空着——卡片其实在磁盘上。
    const directory = await home()
    const first = bench({ homeDir: directory })
    await first.board.ready
    expect((await first.board.ingest({ source: 'webhook', title: '页面报错' })).ok).toBe(true)
    await waitFor(() => first.board.state().cards[0]?.column === 'done', 'the run to finish')
    await first.board.flush()

    const second = bench({ homeDir: directory })
    const pushed: number[] = []
    second.board.subscribe((state) => pushed.push(state.cards.length))
    await second.board.ready
    expect(second.board.state().revision).toBeGreaterThan(0)
    expect(pushed).toContain(1)
  })
})
