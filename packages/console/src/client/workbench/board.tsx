/**
 * The board view: what needs a decision, who is on it, and what is finished.
 *
 * Three columns over one status strip. The strip is the first screen's answer to
 * "how much is on my plate" — 待我决定 / 正在跑 / 今日完成 / 异常 — and every number
 * comes from the board snapshot the Host already sends, so nothing here invents
 * a metric the data does not have (no progress bars, no percentages, no
 * per-card timers).
 *
 * Each column explains itself: a name, a count, one line saying what dropping a
 * card there does, and an empty state that says what would appear. That is the
 * difference between a board that reads at a glance and three empty boxes.
 *
 * Dragging stays HTML5 DnD (the shape v0 already had, and the one a browser
 * gives us for free) with the two things it was missing: a drop-target state
 * while a card is over a column, and a menu path on every card, because drag is
 * not reachable with a keyboard.
 *
 * @module @free-lzj/dsh-console/client/workbench/board
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconChevronDownOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchState, WorkbenchColumn } from '../../protocol.ts'
import type { Translate } from '../locales.ts'
import { CLS } from '../styles.ts'
import {
  BoardCard, CardDetail, COLUMNS, columnDot, columnEmptyKey, columnHintKey, columnLabelKey,
} from './card.tsx'

/** Everything the board reads and calls, injected by the plugin's `apply`. */
export interface WorkbenchFace {
  /** Selector hook over the board state. */
  readonly useBoard: SnapshotSelectorHook<WorkbenchState | undefined>
  /** Post one inbound event; resolves to the Host's answer. */
  readonly ingest: (event: { source: string; title: string; body?: string }) => Promise<Record<string, unknown>>
  /** Dispatch one card. */
  readonly dispatch: (cardId: string, executor?: string) => Promise<boolean>
  /** Move one card between columns. */
  readonly move: (cardId: string, column: WorkbenchColumn) => Promise<boolean>
  /** Send a follow-up message into a session. */
  readonly interrupt: (sessionId: string, text: string) => Promise<boolean>
  /** Pause a session. */
  readonly pause: (sessionId: string) => Promise<boolean>
  /** Resume a paused session. */
  readonly resume: (sessionId: string) => Promise<boolean>
  /** End a session. */
  readonly end: (sessionId: string) => Promise<boolean>
  /** Mark a finished card as written back (clears the confirmation flag). */
  readonly confirm: (cardId: string) => Promise<boolean>
}

/**
 * What the board shows when the Host mounted none: a sentence, not an empty grid.
 * @param props.t - the translate seat.
 * @returns the empty state.
 */
export function WorkbenchUnavailable({ t }: { readonly t: Translate }): ReactNode {
  return <p className={CLS.viewEmpty}>{t('boardMissing')}</p>
}

/** The four figures the strip shows, all derived from the snapshot's cards. */
function statistics(cards: WorkbenchState['cards'], now: number): {
  readonly todo: number
  readonly running: number
  readonly doneToday: number
  readonly failed: number
} {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const since = dayStart.getTime()
  return {
    todo: cards.filter((card) => card.column === 'todo').length,
    running: cards.filter((card) => card.column === 'processing').length,
    doneToday: cards.filter((card) => card.column === 'done' && card.updatedAt >= since).length,
    failed: cards.filter((card) => card.status === 'failed').length,
  }
}

/** The local calendar day one instant belongs to, as a comparable key. */
export function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** One day of finished work. */
export interface DoneDay {
  readonly key: string
  readonly label: string
  readonly cards: readonly WorkbenchState['cards'][number][]
}

/**
 * Group finished cards by the day they last moved.
 *
 * Q6 settled the shape: the column expands **today only**, and everything older
 * folds into one disclosure per day — a work desk that scrolls back a month is a
 * work desk nobody reads. Order is newest first inside a day, newest day first.
 * @param cards - the finished cards.
 * @param now - the reading moment, so "today" means one thing per render.
 * @param t - the translate seat.
 * @returns the days, newest first.
 */
export function groupDoneByDay(
  cards: readonly WorkbenchState['cards'][number][],
  now: number,
  t: Translate,
): readonly DoneDay[] {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const todayKey = dayKey(now)
  const yesterdayKey = dayKey(yesterday.getTime())
  const days = new Map<string, WorkbenchState['cards'][number][]>()
  for (const card of [...cards].sort((left, right) => right.updatedAt - left.updatedAt)) {
    const key = dayKey(card.updatedAt)
    const bucket = days.get(key)
    if (bucket === undefined) days.set(key, [card])
    else bucket.push(card)
  }
  return [...days.entries()].map(([key, dayCards]) => ({
    key,
    label: key === todayKey
      ? t('dayToday')
      : key === yesterdayKey ? t('dayYesterday') : new Date(dayCards[0]?.updatedAt ?? now).toLocaleDateString(),
    cards: dayCards,
  }))
}

/**
 * Draw the board.
 * @param props.face - the board face the Host injected.
 * @param props.t - the translate seat.
 * @returns the strip and the three columns.
 */
export function BoardView({ face, t }: { readonly face: WorkbenchFace; readonly t: Translate }): ReactNode {
  const state = face.useBoard((current) => current)
  /** The column a card is currently hovering over, so it can show it will take it. */
  const [over, setOver] = useState<WorkbenchColumn | undefined>(undefined)
  /** The card whose detail dialog is open, by id (the snapshot is the source of truth). */
  const [openCardId, setOpenCardId] = useState<string | undefined>(undefined)
  /** Why the last action did not take; empty means nothing failed. */
  const [failure, setFailure] = useState('')
  /** The days the user opened or closed in 已处理; absent means "today's default". */
  const [openedDays, setOpenedDays] = useState<Readonly<Record<string, boolean>>>({})
  /** The board root, used to read the visible card order for `j` / `k`. */
  const boardRef = useRef<HTMLDivElement>(null)

  if (state === undefined) return <p className={CLS.viewEmpty}>{t('boardLoading')}</p>

  const now = Date.now()
  const counts = statistics(state.cards, now)
  const openCard = state.cards.find((card) => card.id === openCardId)
  const openSession = openCard?.sessionId === undefined
    ? undefined
    : state.sessions.find((session) => session.id === openCard.sessionId)

  /**
   * Run one action and say so when it does not take.
   *
   * v0 swallowed every failure (`void`), which reads as "nothing happened" to the
   * user; a card that stayed put deserves a sentence.
   * @param work - the action's answer.
   */
  const run = (work: Promise<boolean>): void => {
    void work.then((ok) => { setFailure(ok ? '' : t('boardActionFailed')) })
  }

  /** Which day groups the user has opened or closed; today starts open (Q6). */
  const isDayOpen = (key: string): boolean => openedDays[key] ?? key === dayKey(now)
  const toggleDay = (key: string): void => {
    setOpenedDays((current) => ({ ...current, [key]: !(current[key] ?? key === dayKey(now)) }))
  }

  /** One list of cards, whichever column shape asked for it. */
  const cardList = (cards: readonly WorkbenchState['cards'][number][]): ReactNode => (
    <ul className={CLS.cardsList}>
      {cards.map((card) => (
        <li key={card.id}>
          <BoardCard
            card={card}
            t={t}
            now={now}
            onOpen={() => { setOpenCardId(card.id) }}
            onDispatch={() => { run(face.dispatch(card.id, card.executor)) }}
            onMove={(next) => { run(face.move(card.id, next)) }}
            onDragEnd={() => { setOver(undefined) }}
          />
        </li>
      ))}
    </ul>
  )

  /**
   * `j` / `k` walk the cards that are actually on screen, in reading order.
   *
   * Reading the order off the DOM keeps one source of truth for "what is
   * visible": a card inside a collapsed day is not in that list, so the cursor
   * never lands somewhere the user cannot see.
   * @param event - the key event, bubbled from whichever child had focus.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'j' && event.key !== 'k') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]') !== null) return
    const cards = [...(boardRef.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])]
    const index = cards.findIndex((card) => card === document.activeElement)
    const next = event.key === 'j'
      ? index + 1
      : (index === -1 ? cards.length - 1 : index - 1)
    const element = cards[next]
    if (element === undefined) return
    event.preventDefault()
    element.focus()
  }

  return (
    <div className={CLS.board} ref={boardRef} onKeyDown={onKeyDown}>
      <div className={CLS.statusBar} role="group" aria-label={t('boardTitle')}>
        <Stat label={t('boardStatTodo')} value={counts.todo} dot="idle" />
        <Stat label={t('boardStatRunning')} value={counts.running} dot="ongoing" />
        <Stat label={t('boardStatDone')} value={counts.doneToday} dot="done" />
        <Stat label={t('boardStatFailed')} value={counts.failed} dot={counts.failed > 0 ? 'error' : 'idle'} />
      </div>
      {failure === '' ? null : <p className={CLS.boardFailure} role="status">{failure}</p>}
      <div className={CLS.boardColumns}>
        {COLUMNS.map((column) => {
          const cards = state.cards.filter((card) => card.column === column)
          return (
            <section
              key={column}
              className={over === column ? `${CLS.column} ${CLS.columnOver}` : CLS.column}
              aria-label={t(columnLabelKey(column))}
              onDragOver={(event) => {
                // Preventing the default is what makes this a drop target at all.
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (over !== column) setOver(column)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) return
                setOver((current) => (current === column ? undefined : current))
              }}
              onDrop={(event) => {
                event.preventDefault()
                setOver(undefined)
                const cardId = event.dataTransfer.getData('text/plain')
                if (cardId !== '') run(face.move(cardId, column))
              }}
            >
              <header className={CLS.columnHead}>
                <div className={CLS.columnTitleRow}>
                  <StateDot state={columnDot(column)} />
                  <h3 className={CLS.columnTitle}>{t(columnLabelKey(column))}</h3>
                  <span className={CLS.columnCount}>{cards.length}</span>
                </div>
                <p className={CLS.columnHint}>{t(columnHintKey(column))}</p>
              </header>
              {cards.length === 0
                ? <p className={CLS.columnEmpty}>{t(columnEmptyKey(column))}</p>
                : column === 'done'
                  ? (
                    // 已处理按天折叠（Q6）：今天展开，更早的每天一行，点开才列。
                    // 只有一天（且就是今天）时不分组——那层折叠只在一列真有历史时才有意义。
                    doneColumn(cards, now, t, cardList, isDayOpen, toggleDay)
                  )
                  : cardList(cards)}
            </section>
          )
        })}
      </div>
      {/* 这条注脚说的是数据从哪来、哪里还不真，属于脚注而不是抬头，排在列下面。 */}
      <p className={CLS.boardHint}>{t('boardHint')}</p>
      {openCard !== undefined && (
        <CardDetail
          card={openCard}
          {...(openSession === undefined ? {} : { session: openSession })}
          t={t}
          now={now}
          onClose={() => { setOpenCardId(undefined) }}
          onDispatch={() => { run(face.dispatch(openCard.id, openCard.executor)) }}
          onMove={(column) => { run(face.move(openCard.id, column)) }}
          onConfirm={() => { run(face.confirm(openCard.id)) }}
          onInterrupt={(text) => {
            if (openSession === undefined) return
            run(face.interrupt(openSession.id, text))
          }}
          onStop={() => {
            if (openSession === undefined) return
            run(face.end(openSession.id))
          }}
        />
      )}
    </div>
  )
}

/**
 * Draw the finished column: one flat list while everything belongs to today, and
 * one disclosure per day as soon as there is older work to fold away (Q6).
 * @param cards - the finished cards.
 * @param now - the reading moment.
 * @param t - the translate seat.
 * @param cardList - the shared card renderer.
 * @param isOpen - whether one day is expanded.
 * @param toggle - flips one day.
 * @returns the column body.
 */
function doneColumn(
  cards: readonly WorkbenchState['cards'][number][],
  now: number,
  t: Translate,
  cardList: (cards: readonly WorkbenchState['cards'][number][]) => ReactNode,
  isOpen: (key: string) => boolean,
  toggle: (key: string) => void,
): ReactNode {
  const days = groupDoneByDay(cards, now, t)
  if (days.length === 1 && days[0]?.key === dayKey(now)) return cardList(cards)
  return (
    <div className={CLS.dayGroups}>
      {days.map((day) => (
        <div key={day.key} className={CLS.dayGroup}>
          <DisclosureRow
            icon={<IconChevronDownOutlineRegular />}
            title={`${day.label} · ${day.cards.length}`}
            open={isOpen(day.key)}
            expandable
            expandOnRowClick
            onToggle={() => { toggle(day.key) }}
          />
          {isOpen(day.key) && cardList(day.cards)}
        </div>
      ))}
    </div>
  )
}

/**
 * One figure in the strip: dot, number, name.
 * @param props.label - the localized name.
 * @param props.value - the count.
 * @param props.dot - the state the number flies under.
 * @returns the figure.
 */
function Stat(props: {
  readonly label: string
  readonly value: number
  readonly dot: 'idle' | 'ongoing' | 'done' | 'error'
}): ReactNode {
  return (
    <div className={CLS.stat}>
      <StateDot state={props.dot} />
      <span className={CLS.statValue}>{props.value}</span>
      <span className={CLS.statLabel}>{props.label}</span>
    </div>
  )
}
