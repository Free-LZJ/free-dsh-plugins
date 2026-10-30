/**
 * The workbench's session port: the half of the contract connectors use.
 *
 * What it pins: the verbs are `sessionController`'s (the only proven path on this
 * host), a session this port created becomes a board card, assistant output
 * lands in that card's log, and a follow-up into someone else's session does not
 * invent a card.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/session-port
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchBoard } from '../../src/workbench/board.ts'
import {
  createWorkbenchSessionPort,
  type ControllerAgentLike,
  type SessionControllerLike,
} from '../../src/workbench/session-port.ts'

type EventListener = (session: { readonly id?: string }, event: unknown) => void

/** A context with one controller and a captured `session/event` listener. */
function harness(options: { withController?: boolean } = {}): {
  ctx: Context
  board: WorkbenchBoard
  listener: () => EventListener
  calls: string[]
} {
  const calls: string[] = []
  const listeners: EventListener[] = []
  const agent: ControllerAgentLike = {
    session: { id: 's-1' },
    followup: (message) => {
      const text = (message as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? ''
      calls.push(`followup:${text}`)
      return undefined
    },
  }
  const controller: SessionControllerLike = {
    async create(request) {
      calls.push(`create:${request.cwd}`)
      return { sessionId: 's-1' }
    },
    async rename(request) {
      calls.push(`rename:${request.sessionId}:${request.title}`)
      return undefined
    },
    async resolveAgent(sessionId) {
      calls.push(`resolve:${sessionId}`)
      return { agent }
    },
  }
  const ctx = {
    get: (name: string) => (name === 'sessionController' && options.withController !== false ? controller : undefined),
    on: (_name: string, listener: EventListener) => {
      listeners.push(listener)
      return () => undefined
    },
  } as unknown as Context
  const board = {
    recordSessionCard: vi.fn(),
    appendSessionLog: vi.fn(),
    finishSession: vi.fn(),
  } as unknown as WorkbenchBoard
  return { ctx, board, listener: () => listeners[0] as EventListener, calls }
}

describe('createWorkbenchSessionPort', () => {
  it('creates, names, delivers, and adopts the session as a card', async () => {
    const { ctx, board, calls } = harness()
    const port = createWorkbenchSessionPort(ctx, board)
    const created = await port.createSession({ cwd: 'D:/dsh-work' })
    await port.rename(created.sessionId, 'Jira 派单：EXEPD-1')
    await port.followup(created.sessionId, '读单并派单', { plugin: 'dsh-mail', form: 'mail', ruleId: 'jira-bugfix' })

    expect(calls).toEqual([
      'create:D:/dsh-work',
      'rename:s-1:Jira 派单：EXEPD-1',
      'resolve:s-1',
      'followup:读单并派单',
    ])
    expect(board.recordSessionCard).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-1',
      title: 'Jira 派单：EXEPD-1',
      source: 'mail',
      ruleName: 'jira-bugfix',
    }))
  })

  it('sends assistant output and the turn result to the card', async () => {
    const { ctx, board, listener } = harness()
    const port = createWorkbenchSessionPort(ctx, board)
    const created = await port.createSession({ cwd: 'D:/dsh-work' })
    await port.rename(created.sessionId, '会话')
    const onEvent = listener()
    onEvent({ id: 's-1' }, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '已派单' }] } },
    })
    onEvent({ id: 's-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    expect(board.appendSessionLog).toHaveBeenCalledWith('s-1', '已派单')
    expect(board.finishSession).toHaveBeenCalledWith('s-1', 'done')
  })

  it('does not invent a card for a follow-up into a session it did not create', async () => {
    const { ctx, board } = harness()
    const port = createWorkbenchSessionPort(ctx, board)
    await port.followup('elsewhere', '喂', { plugin: 'dsh-mail', form: 'mail' })
    expect(board.recordSessionCard).not.toHaveBeenCalled()
  })

  it('says the deployment has no session service instead of half-working', async () => {
    const { ctx, board } = harness({ withController: false })
    const port = createWorkbenchSessionPort(ctx, board)
    await expect(port.createSession({ cwd: 'D:/dsh-work' })).rejects.toThrow('没有会话服务')
  })
})
