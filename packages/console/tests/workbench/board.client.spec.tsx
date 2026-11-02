// @vitest-environment jsdom
/**
 * The board on screen: the status strip, the three columns, the card anatomy,
 * the detail dialog, and the two ways to move a card.
 *
 * Driven through a fake face, so no network is involved. What these tests pin is
 * what the user meets — and, for the parts v0 lacked, what they must now be able
 * to do: read a card without opening it, open the audit dialog, and move a card
 * with the keyboard rather than only by dragging.
 *
 * @module @free-dzj/dsh-console/tests/workbench/board-client
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleNoticeRecord, WorkbenchCard, WorkbenchColumn, WorkbenchState } from '../../src/protocol.ts'
import { en as enDictionary, zh, type Translate } from '../../src/client/locales.ts'
import { BoardView, type WorkbenchFace } from '../../src/client/workbench/board.tsx'
import { dedupeReasons, reasonText } from '../../src/client/workbench/card.tsx'

afterEach(cleanup)

/** Translate through the real dictionary, so a missing key fails here too. */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** The single instant this file treats as "now", so relative times stay stable. */
const NOW = Date.now()

/** One card, with the fields the anatomy draws. */
function card(overrides: Partial<WorkbenchCard> & Pick<WorkbenchCard, 'id' | 'column'>): WorkbenchCard {
  return {
    source: 'mail',
    dedupeKey: `mail:${overrides.id}`,
    rootId: overrides.id,
    title: '卡片',
    status: 'idle',
    priority: 'normal',
    kind: 'unknown',
    confidence: 0.3,
    awaitingConfirmation: false,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 120_000,
    decision: {
      action: 'hold',
      routeId: 'low-confidence',
      ruleVersion: 'workbench-routes-v1',
      classification: { kind: 'unknown', priority: 'normal', confidence: 0.3, reasons: [] },
      reasons: [{ code: 'classify-keyword-hit', params: { kind: 'bug', count: 1 } }],
    },
    ...overrides,
  }
}

/** One board state, as the Host would answer it. */
function board(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    cards: [
      card({
        id: 'card-todo',
        column: 'todo',
        title: '今天天气不错',
        externalId: 'PROJ-142',
        body: '一封来源不明的邮件，没有足够线索自动派单。',
        priority: 'high',
        confidence: 0.3,
      }),
      card({
        id: 'card-running',
        column: 'processing',
        title: '页面报错',
        source: 'webhook',
        status: 'running',
        priority: 'normal',
        kind: 'bug',
        confidence: 0.8,
        executor: 'dsh',
        sessionId: 'session-1',
      }),
      card({
        id: 'card-done',
        column: 'done',
        title: '已回写的工单',
        status: 'done',
        kind: 'bug',
        confidence: 0.9,
        executor: 'codex',
        updatedAt: NOW,
      }),
    ],
    sessions: [
      {
        id: 'session-1',
        cardId: 'card-running',
        executor: 'dsh',
        status: 'running',
        logs: [{ at: NOW - 60_000, text: '开始处理，正在复现问题…' }],
        createdAt: NOW - 120_000,
        updatedAt: NOW - 60_000,
      },
    ],
    connectors: [],
    executors: [{ id: 'dsh', label: 'DSH 会话' }],
    executorNote: '',
    routingVersion: 'workbench-routes-v1',
    revision: 1,
    ...overrides,
  }
}

/** The face, recording what it was asked to do. */
function face(state: WorkbenchState = board(), issued: readonly ConsoleNoticeRecord[] = []) {
  const calls = {
    dispatch: [] as string[],
    move: [] as { cardId: string; column: WorkbenchColumn }[],
    interrupt: [] as { sessionId: string; text: string }[],
    confirm: [] as string[],
    end: [] as string[],
    detach: [] as string[],
  }
  const fake: WorkbenchFace = {
    useBoard: <S,>(select: (current: WorkbenchState | undefined) => S) => select(state),
    useNotices: <S,>(select: (current: readonly ConsoleNoticeRecord[]) => S) => select(issued),
    dispatch: async (cardId) => {
      calls.dispatch.push(cardId)
      return true
    },
    move: async (cardId, column) => {
      calls.move.push({ cardId, column })
      return true
    },
    detach: async (cardId) => {
      calls.detach.push(cardId)
      return true
    },
    confirm: async (cardId) => {
      calls.confirm.push(cardId)
      return true
    },
    interrupt: async (sessionId, text) => {
      calls.interrupt.push({ sessionId, text })
      return true
    },
    pause: async () => true,
    resume: async () => true,
    end: async (sessionId) => {
      calls.end.push(sessionId)
      return true
    },
  }
  return { calls, face: fake }
}

/** The card element carrying this title. */
function cardOf(title: string): HTMLElement {
  return screen.getByRole('article', { name: title })
}

/** The number inside one status-strip figure. */
function stat(label: string): string {
  const strip = screen.getByRole('group', { name: t('boardTitle') })
  const node = within(strip).getByText(label).parentElement
  return node?.textContent?.replace(label, '').trim() ?? ''
}

/** A drag-and-drop data store, since jsdom ships no `DataTransfer`. */
function transfer(cardId: string): Record<string, unknown> {
  const store = new Map<string, string>([['text/plain', cardId]])
  return {
    setData: (type: string, value: string) => { store.set(type, value) },
    getData: (type: string) => store.get(type) ?? '',
    effectAllowed: 'move',
    dropEffect: 'move',
  }
}

describe('the board on screen', () => {
  it('draws one card for a whole chain, with every step inside its detail', () => {
    // 同一件事派生出来的卡共用一个 rootId：板上一张，详情里按顺序一排。
    const root = card({ id: 'root-1', column: 'done', title: 'DSH E2E 派单' })
    const child = card({ id: 'child-2', column: 'done', rootId: 'root-1', title: '子会话' })
    const notice: ConsoleNoticeRecord = {
      id: 'notice-1',
      rootId: 'root-1',
      title: '已完成',
      createdAt: NOW - 30_000,
      delivered: ['inapp'],
      state: 'new',
    }
    const { face: fake } = face(board({ cards: [root, child] }), [notice])
    render(<BoardView face={fake} t={t} />)
    expect(screen.getAllByRole('article')).toHaveLength(1)
    const article = cardOf('DSH E2E 派单')
    expect(within(article).getByText(t('chainSteps', { count: 2 }))).toBeTruthy()

    fireEvent.click(within(article).getByRole('button', { name: t('cardDetail') }))
    const dialog = screen.getByRole('dialog', { name: 'DSH E2E 派单' })
    // 宽弹窗靠两栏把「是什么」与「怎么走到现在」分开：单列时链路标题只能折行。
    expect(dialog.querySelector('.dshc-card-detail-columns')).toBeTruthy()
    expect(within(dialog).getByText('子会话')).toBeTruthy()
    // 通知也是这件事的一步，不是并列的另一条。
    expect(within(dialog).getByText('已完成')).toBeTruthy()
    // 重播是重挂载：点一下不该把步骤弄丢。
    fireEvent.click(within(dialog).getByRole('button', { name: t('detailReplay') }))
    expect(within(dialog).getByText('子会话')).toBeTruthy()
  })

  it('says an inferred chain may be wrong, and takes a step back out', () => {
    // 推断会合错：界面必须说出来，并且给一个真正生效的撤销。
    const cards = [
      card({ id: 'root-1', column: 'done', title: 'DSH E2E 派单', chainInferred: true, createdAt: NOW - 600_000 }),
      card({ id: 'child-2', column: 'done', title: 'DSH E2E 子会话', rootId: 'root-1', chainInferred: true, createdAt: NOW - 300_000 }),
    ]
    const { calls, face: fake } = face(board({ cards }))
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(within(cardOf('DSH E2E 派单')).getByRole('button', { name: t('cardDetail') }))
    const dialog = screen.getByRole('dialog', { name: 'DSH E2E 派单' })
    expect(within(dialog).getByText(t('chainInferredHint'))).toBeTruthy()
    // 只给「推断进来的成员」撤销入口，根自己不给——拆根没有意义。
    const detachButtons = within(dialog).getAllByRole('button', { name: t('chainDetach') })
    expect(detachButtons).toHaveLength(1)
    fireEvent.click(detachButtons[0] as HTMLElement)
    expect(calls.detach).toEqual(['child-2'])
  })

  it('counts the four figures from the snapshot', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    expect(stat(t('boardStatTodo'))).toBe('1')
    expect(stat(t('boardStatRunning'))).toBe('1')
    expect(stat(t('boardStatDone'))).toBe('1')
    expect(stat(t('boardStatFailed'))).toBe('0')
  })

  it('draws three columns, each with a name, a count and a hint', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const todo = screen.getByRole('region', { name: t('boardTodo') })
    expect(within(todo).getByText('1')).toBeTruthy()
    expect(within(todo).getByText(t('boardTodoHint'))).toBeTruthy()
    expect(screen.getByRole('region', { name: t('boardProcessing') })).toBeTruthy()
    expect(screen.getByRole('region', { name: t('boardDone') })).toBeTruthy()
  })

  it('explains an empty board once, not once per column', () => {
    // 空看板不再画统计条与三个空框：一句话就够，重复三次比「没活」更响。
    const { face: fake } = face(board({ cards: [] }))
    render(<BoardView face={fake} t={t} />)
    expect(screen.getByText(t('boardEmpty'))).toBeTruthy()
    expect(screen.queryByRole('group', { name: t('boardTitle') })).toBeNull()
    expect(screen.queryByRole('region', { name: t('boardTodo') })).toBeNull()
  })

  it('answers the five card questions without opening anything', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const article = cardOf('今天天气不错')
    // Where from, which ticket, how urgent.
    expect(within(article).getByText(t('sourceMail'))).toBeTruthy()
    expect(within(article).getByText('PROJ-142')).toBeTruthy()
    expect(within(article).getByText(t('priorityHigh'))).toBeTruthy()
    // What it says.
    expect(within(article).getByText('一封来源不明的邮件，没有足够线索自动派单。')).toBeTruthy()
    // How sure, and which rule decided.
    expect(within(article).getByText(t('cardConfidence', { value: 30 }))).toBeTruthy()
    // 规则版本是审计信息，收进详情；卡面只回答「哪来的、多急、谁在干、干到哪」。
    expect(within(article).queryByText(/workbench-routes-v1/)).toBeNull()
    expect(within(article).getByText(t('kindUnknown'))).toBeTruthy()
    // Who has it, how far along, and when it last moved.
    expect(within(article).getByText(t('cardNoExecutor'))).toBeTruthy()
    expect(within(article).getByText(t('statusIdle'))).toBeTruthy()
    expect(within(article).getByText(t('minutesAgo', { count: 2 }))).toBeTruthy()
  })

  it('says why a low-confidence card was not dispatched', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    expect(within(cardOf('今天天气不错')).getByText(t('cardLowConfidence'))).toBeTruthy()
    // 80% is above the threshold: no explanation line there.
    expect(within(cardOf('页面报错')).queryByText(t('cardLowConfidence'))).toBeNull()
  })

  it('dispatches a held card from its action bar', () => {
    const { calls, face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(within(cardOf('今天天气不错')).getByRole('button', { name: t('cardDispatch') }))
    expect(calls.dispatch).toEqual(['card-todo'])
  })

  it('moves a card between columns from the menu, without a pointer drag', () => {
    // 这条盯的是 v0 的唯一移列手段：只能拖。拖拽不可键盘化，所以卡片上必须有等价菜单。
    const { calls, face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(within(cardOf('今天天气不错')).getByRole('button', { name: t('cardMove') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('boardProcessing') }))
    expect(calls.move).toEqual([{ cardId: 'card-todo', column: 'processing' }])
  })

  it('marks the column a dragged card is over, and moves it on drop', () => {
    const { calls, face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const dataTransfer = transfer('card-todo')
    const article = cardOf('今天天气不错')
    const target = screen.getByRole('region', { name: t('boardProcessing') })
    fireEvent.dragStart(article, { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer })
    expect(target.classList.contains('dshc-column-over')).toBe(true)
    fireEvent.drop(target, { dataTransfer })
    expect(target.classList.contains('dshc-column-over')).toBe(false)
    expect(calls.move).toEqual([{ cardId: 'card-todo', column: 'processing' }])
  })

  it('opens the detail dialog from the card, and closes it on Escape', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const article = cardOf('今天天气不错')
    fireEvent.keyDown(article, { key: 'Enter' })
    const dialog = screen.getByRole('dialog', { name: '今天天气不错' })
    // The audit trail is the reason the dialog exists: why, and when.
    expect(within(dialog).getByText(t('detailReasons'))).toBeTruthy()
    // 判据在 Host 那边是代码，文字由这一页按 locales 渲染。
    expect(within(dialog).getByText(t('reasonClassifyKeywordHit', { kind: 'bug', count: 1 }))).toBeTruthy()
    expect(within(dialog).getByText(t('detailChain'))).toBeTruthy()
    // 链路的第一步就是这张卡自己：步骤条至少要能读出它在哪一步、什么时候。
    expect(within(dialog).getByText(t('detailReplay'))).toBeTruthy()
    expect(within(dialog).getAllByText('今天天气不错').length).toBeGreaterThan(0)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '今天天气不错' })).toBeNull()
  })

  it('shows a running card its session log and takes an interrupt', () => {
    const { calls, face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(within(cardOf('页面报错')).getByRole('button', { name: t('cardDetail') }))
    const dialog = screen.getByRole('dialog', { name: '页面报错' })
    expect(within(dialog).getByText('开始处理，正在复现问题…')).toBeTruthy()
    fireEvent.change(within(dialog).getByPlaceholderText(t('interruptPlaceholder')), { target: { value: '先别动那一行' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t('interruptSend') }))
    expect(calls.interrupt).toEqual([{ sessionId: 'session-1', text: '先别动那一行' }])
    // 停止是另一种意图：插话是催它，停止是拦它——但拦之前必须显式确认。
    fireEvent.click(within(dialog).getByRole('button', { name: t('sessionStop') }))
    expect(calls.end).toEqual([])
    const confirm = screen.getByRole('dialog', { name: t('stopConfirmTitle') })
    const confirmButton = within(confirm).getByRole('button', { name: t('sessionStop') }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    fireEvent.click(within(confirm).getByRole('checkbox', { name: t('stopConfirmAcknowledge') }))
    fireEvent.click(confirmButton)
    expect(calls.end).toEqual(['session-1'])
  })

  it('offers "written back" on a finished card that still awaits it', () => {
    const done = board({
      cards: [{
        ...(board().cards[0] as WorkbenchState['cards'][number]),
        column: 'done',
        status: 'done',
        awaitingConfirmation: true,
      }],
    })
    const { calls, face: fake } = face(done)
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(within(cardOf('今天天气不错')).getByRole('button', { name: t('cardDetail') }))
    const dialog = screen.getByRole('dialog', { name: '今天天气不错' })
    fireEvent.click(within(dialog).getByRole('button', { name: t('cardConfirm') }))
    expect(calls.confirm).toEqual([(done.cards[0] as WorkbenchState['cards'][number]).id])
  })

  it('says the board is loading before the first snapshot', () => {
    const fake: WorkbenchFace = {
      useBoard: <S,>(select: (current: WorkbenchState | undefined) => S) => select(undefined),
      useNotices: <S,>(select: (current: readonly ConsoleNoticeRecord[]) => S) => select([]),
      dispatch: async () => true,
      move: async () => true,
      interrupt: async () => true,
      pause: async () => true,
      resume: async () => true,
      end: async () => true,
      confirm: async () => true,
      detach: async () => true,
    }
    render(<BoardView face={fake} t={t} />)
    expect(screen.getByText(t('boardLoading'))).toBeTruthy()
  })
})

describe('reason wording', () => {
  it('words a code through the locales, with its parameters', () => {
    expect(reasonText({ code: 'classify-keyword-hit', params: { kind: 'bug', count: 2 } }, t))
      .toBe(t('reasonClassifyKeywordHit', { kind: 'bug', count: 2 }))
    expect(reasonText({ code: 'route-matched', params: { route: 'bug-to-dsh' } }, t)).toContain('bug-to-dsh')
  })

  it('words the same code in the other language too', () => {
    // 判据的文字归页面：同一张卡在英文界面下不该出现中文句子。
    const en = (key: string, params?: Record<string, unknown>): string => {
      const template: string = (enDictionary as Record<string, string>)[key] ?? key
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
    }
    const shown = reasonText({ code: 'classify-keyword-hit', params: { kind: 'bug', count: 1 } }, en as unknown as Translate)
    expect(shown).toBe('Matched 1 bug keyword(s)')
    expect(shown).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('shows the sentence an older build stored, verbatim', () => {
    expect(reasonText({ code: 'legacy', text: '关键词「报错」命中 bug 类' }, t)).toBe('关键词「报错」命中 bug 类')
  })

  it('falls back to stored text for a code this build does not know', () => {
    expect(reasonText({ code: 'from-a-newer-build', text: '一种新的判据' }, t)).toBe('一种新的判据')
  })

  it('never shows a raw code to the user', () => {
    const shown = reasonText({ code: 'from-a-newer-build' }, t)
    expect(shown).toBe(t('reasonUnknown'))
    expect(shown).not.toContain('from-a-newer-build')
  })

  it('shows one copy of a line both routing and classification recorded', () => {
    // 两处各记一遍同一条理由，拼起来就是同一句话连出现两次——看第二遍没有新信息。
    expect(dedupeReasons([{ code: 'classify-none' }, { code: 'classify-none' }])).toHaveLength(1)
    // 参数不同就是两条：按 code 合并会把两条不同的判断吞掉。
    expect(dedupeReasons([
      { code: 'route-matched', params: { route: 'a' } },
      { code: 'route-matched', params: { route: 'b' } },
    ])).toHaveLength(2)
    // 参数键的书写顺序不同也还是同一条。
    expect(dedupeReasons([
      { code: 'route-low-confidence', params: { confidence: 0.3, threshold: 0.6 } },
      { code: 'route-low-confidence', params: { threshold: 0.6, confidence: 0.3 } },
    ])).toHaveLength(1)
  })
})

/** Two days back, so the finished column has history to fold. */
const TWO_DAYS_AGO = NOW - 2 * 24 * 60 * 60 * 1000

/** The board with one finished card from today and one from two days ago. */
function boardWithHistory(): WorkbenchState {
  const base = board()
  return {
    ...base,
    cards: [
      card({
        id: 'card-old',
        column: 'done',
        title: '前天收工的工单',
        status: 'done',
        kind: 'bug',
        confidence: 0.9,
        executor: 'codex',
        createdAt: TWO_DAYS_AGO,
        updatedAt: TWO_DAYS_AGO,
      }),
      ...base.cards,
    ],
  }
}

describe('the finished column', () => {
  /** The disclosure rows of the finished column, newest day first. */
  function dayRows(): HTMLElement[] {
    const column = screen.getByRole('region', { name: t('boardDone') })
    return [...column.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
  }

  it('expands today and folds the older days (Q6)', () => {
    const { face: fake } = face(boardWithHistory())
    render(<BoardView face={fake} t={t} />)
    // 今天那张还在，前天那张折起来了。
    expect(screen.getByText('已回写的工单')).toBeTruthy()
    expect(screen.queryByText('前天收工的工单')).toBeNull()
    expect(dayRows().length).toBe(2)
    expect(screen.getByText(`${t('dayToday')} · 1`)).toBeTruthy()
  })

  it('opens a folded day when its row is picked', () => {
    const { face: fake } = face(boardWithHistory())
    render(<BoardView face={fake} t={t} />)
    fireEvent.click(dayRows()[1] as HTMLElement)
    expect(screen.getByText('前天收工的工单')).toBeTruthy()
  })

  it('does not walk into a folded day with j', () => {
    // 折叠的那天不在 DOM 里，光标就不该落进去——j/k 走的是「屏幕上有的卡」。
    const { face: fake } = face(boardWithHistory())
    render(<BoardView face={fake} t={t} />)
    const last = cardOf('已回写的工单')
    last.focus()
    fireEvent.keyDown(last, { key: 'j' })
    expect(document.activeElement).toBe(last)
  })
})

describe('the keyboard cursor', () => {
  it('walks the visible cards with j and k', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const first = cardOf('今天天气不错')
    first.focus()
    fireEvent.keyDown(first, { key: 'j' })
    expect(document.activeElement).toBe(cardOf('页面报错'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'j' })
    expect(document.activeElement).toBe(cardOf('已回写的工单'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'k' })
    expect(document.activeElement).toBe(cardOf('页面报错'))
  })

  it('goes to the last card on k from outside the cards', () => {
    const { face: fake } = face()
    render(<BoardView face={fake} t={t} />)
    const board = screen.getByRole('group', { name: t('boardTitle') })
    fireEvent.keyDown(board, { key: 'k' })
    expect(document.activeElement).toBe(cardOf('已回写的工单'))
  })
})

