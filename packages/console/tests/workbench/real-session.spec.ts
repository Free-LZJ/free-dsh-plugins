/**
 * The real executor, driven without a harness.
 *
 * Two things are worth pinning here: a run that **fails to start** must still
 * settle the card (otherwise it sits in `processing` forever), and `end` must
 * settle it too — a stopped run is a run that ends, not one that hangs. Both are
 * exactly the failure modes the board review called out for the simulated
 * executor, so the real one is held to them from the start.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/real-session
 */

import { describe, expect, it } from 'vitest'
import { RealSessionExecutor, promptFor, type RealRun, type SessionRunner } from '../../src/workbench/real-session.ts'
import type { SessionSink } from '../../src/workbench/executors.ts'
import type { WorkbenchCard } from '../../src/protocol.ts'

/** A card as the board would hand it over. */
function card(overrides: Partial<WorkbenchCard> = {}): WorkbenchCard {
  return {
    id: 'card-1',
    source: 'mail',
    dedupeKey: 'mail:card-1',
    title: '页面报错',
    column: 'processing',
    status: 'running',
    priority: 'normal',
    kind: 'bug',
    confidence: 0.6,
    awaitingConfirmation: false,
    createdAt: 1,
    updatedAt: 1,
    decision: {
      action: 'dispatch',
      routeId: 'bug-to-dsh',
      ruleVersion: 'v1',
      reasons: [],
      classification: { kind: 'bug', priority: 'normal', confidence: 0.6, reasons: [] },
    },
    ...overrides,
  }
}

/** A sink that records what the board would hear. */
function sink(): SessionSink & { lines: string[]; finished: ('done' | 'failed')[] } {
  const lines: string[] = []
  const finished: ('done' | 'failed')[] = []
  return {
    lines,
    finished,
    log: (text) => lines.push(text),
    finish: (status) => finished.push(status),
  }
}

/** A runner whose run can be settled from the test. */
function runner(mode: 'manual' | 'reject' = 'manual') {
  const calls = { started: [] as { title: string; prompt: string }[], sent: [] as { sessionId: string; text: string }[], stopped: 0 }
  let settleRun: (status: 'done' | 'failed') => void = () => undefined
  const runner: SessionRunner = {
    start: async (request) => {
      calls.started.push(request)
      if (mode === 'reject') throw new Error('没有可用的会话服务')
      const run: RealRun = {
        sessionId: 'session-1',
        finished: new Promise((resolve) => { settleRun = resolve }),
        // 停掉一次运行就是让它以失败收尾——runner 自己负责把 inished 结掉。
        stop: () => {
          calls.stopped += 1
          settleRun('failed')
        },
      }
      return run
    },
    send: async (sessionId, text) => { calls.sent.push({ sessionId, text }) },
  }
  return { calls, runner, settle: (status: 'done' | 'failed') => { settleRun(status) } }
}

describe('promptFor', () => {
  it('turns a card into instructions a fresh agent can act on', () => {
    const prompt = promptFor(card({ body: '复现步骤：打开首页就 500' }))
    expect(prompt).toContain('工作台派单：页面报错')
    expect(prompt).toContain('来源：mail')
    expect(prompt).toContain('分类：bug（置信度 60%）')
    expect(prompt).toContain('复现步骤：打开首页就 500')
  })
})

describe('RealSessionExecutor', () => {
  it('finishes the card with the run outcome', async () => {
    const { runner: port, settle, calls } = runner()
    const board = sink()
    new RealSessionExecutor(port).dispatch(card(), board)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.started[0]?.title).toBe('页面报错')
    expect(board.lines.join('\n')).toContain('会话 session-1 已开始')
    settle('done')
    await Promise.resolve()
    await Promise.resolve()
    expect(board.finished).toEqual(['done'])
  })

  it('still settles the card when the run cannot start', async () => {
    // 这条最关键：启动失败如果不落状态，卡片就永远停在「进行中」。
    const board = sink()
    new RealSessionExecutor(runner('reject').runner).dispatch(card(), board)
    await Promise.resolve()
    await Promise.resolve()
    expect(board.finished).toEqual(['failed'])
    expect(board.lines.join('\n')).toContain('创建会话失败：没有可用的会话服务')
  })

  it('ends a stopped run instead of leaving it pending', async () => {
    const { runner: port } = runner()
    const board = sink()
    const handle = new RealSessionExecutor(port).dispatch(card(), board)
    await Promise.resolve()
    await Promise.resolve()
    handle.end()
    await Promise.resolve()
    expect(board.finished).toEqual(['failed'])
  })

  it('passes an interrupt to the live session', async () => {
    const { runner: port, calls } = runner()
    const board = sink()
    const handle = new RealSessionExecutor(port).dispatch(card(), board)
    await Promise.resolve()
    await Promise.resolve()
    handle.interrupt('先看首页路由')
    await Promise.resolve()
    expect(calls.sent).toEqual([{ sessionId: 'session-1', text: '先看首页路由' }])
  })

  it('says plainly that a running turn cannot be paused', async () => {
    // 一轮对话不能暂停；假装能暂停会让用户以为卡片真的停下了。
    const board = sink()
    const handle = new RealSessionExecutor(runner().runner).dispatch(card(), board)
    await Promise.resolve()
    await Promise.resolve()
    handle.pause()
    expect(board.lines.join('\n')).toContain('不支持暂停')
    // 暂停不改变运行状态：它还在跑，结束时照常收尾。
    expect(board.finished).toEqual([])
  })
})
