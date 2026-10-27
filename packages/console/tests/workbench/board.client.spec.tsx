// @vitest-environment jsdom
/**
 * The board on screen: columns, cards, dispatch, and the session focus view.
 *
 * Driven through a fake face, so no network is involved: what these tests pin
 * is what the user meets — the three columns, the card's facts, the dispatch
 * button's call, and the session log with its interrupt box.
 *
 * @module @free-lzj/dsh-console/tests/workbench/board-client
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../../src/protocol.ts'
import { zh, type Translate } from '../../src/client/locales.ts'
import { WorkbenchSection, type WorkbenchFace } from '../../src/client/workbench/board.tsx'

afterEach(cleanup)

/** Translate through the real dictionary, so a missing key fails here too. */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** One board state, as the Host would answer it. */
const STATE: WorkbenchState = {
  cards: [
    {
      id: 'card-todo',
      source: 'mail',
      dedupeKey: 'mail:title:今天天气不错',
      title: '今天天气不错',
      column: 'todo',
      status: 'idle',
      priority: 'normal',
      kind: 'unknown',
      confidence: 0.3,
      awaitingConfirmation: false,
      createdAt: 1,
      updatedAt: 1,
      decision: {
        action: 'hold',
        routeId: 'low-confidence',
        ruleVersion: 'workbench-routes-v1',
        classification: { kind: 'unknown', priority: 'normal', confidence: 0.3, reasons: [] },
        reasons: [],
      },
    },
    {
      id: 'card-running',
      source: 'webhook',
      dedupeKey: 'webhook:title:页面报错',
      title: '页面报错',
      column: 'processing',
      status: 'running',
      priority: 'high',
      kind: 'bug',
      confidence: 0.8,
      executor: 'dsh',
      sessionId: 'session-1',
      awaitingConfirmation: false,
      createdAt: 2,
      updatedAt: 2,
      decision: {
        action: 'dispatch',
        executor: 'dsh',
        routeId: 'bug-to-dsh',
        ruleVersion: 'workbench-routes-v1',
        classification: { kind: 'bug', priority: 'high', confidence: 0.8, reasons: [] },
        reasons: [],
      },
    },
  ],
  sessions: [
    {
      id: 'session-1',
      cardId: 'card-running',
      executor: 'dsh',
      status: 'running',
      logs: [{ at: 3, text: '开始处理，正在复现问题…' }],
      createdAt: 2,
      updatedAt: 3,
    },
  ],
  connectors: [
    { id: 'mail', label: '邮件', directions: ['in', 'out'], enabled: true, implemented: true },
    { id: 'dingtalk', label: '钉钉', directions: ['in', 'out'], enabled: false, implemented: false, note: '占位' },
  ],
  routingVersion: 'workbench-routes-v1',
  revision: 1,
}

/** The face, recording what it was asked to do. */
function face() {
  const calls = { dispatch: [] as string[], interrupt: [] as { sessionId: string; text: string }[] }
  const fake: WorkbenchFace = {
    useBoard: <S,>(select: (state: WorkbenchState | undefined) => S) => select(STATE),
    ingest: async () => ({ ok: true }),
    dispatch: async (cardId) => {
      calls.dispatch.push(cardId)
      return true
    },
    move: async () => true,
    interrupt: async (sessionId, text) => {
      calls.interrupt.push({ sessionId, text })
      return true
    },
    pause: async () => true,
    resume: async () => true,
    end: async () => true,
  }
  return { calls, face: fake }
}

describe('the board on screen', () => {
  it('draws the three columns and the cards with their facts', () => {
    const { face: fake } = face()
    render(<WorkbenchSection face={fake} t={t} />)
    expect(screen.getByText('任务看板')).toBeTruthy()
    expect(screen.getByText('今天天气不错')).toBeTruthy()
    expect(screen.getByText('页面报错')).toBeTruthy()
    expect(screen.getByText('置信度 30%')).toBeTruthy()
    expect(screen.getByText('置信度 80%')).toBeTruthy()
    expect(screen.getByText('邮件')).toBeTruthy()
    expect(screen.getByText('钉钉')).toBeTruthy()
  })

  it('dispatches the held card from its button', () => {
    const { calls, face: fake } = face()
    render(<WorkbenchSection face={fake} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '派单' }))
    expect(calls.dispatch).toEqual(['card-todo'])
  })

  it('shows the running session log and sends an interrupt', () => {
    const { calls, face: fake } = face()
    render(<WorkbenchSection face={fake} t={t} />)
    expect(screen.getByText('开始处理，正在复现问题…')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('给会话插一句话…'), { target: { value: '先别动那一行' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(calls.interrupt).toEqual([{ sessionId: 'session-1', text: '先别动那一行' }])
  })
})
