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

import { useState, type ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
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

  return (
    <div className={CLS.board}>
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
                : (
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
                )}
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
          onInterrupt={(text) => {
            if (openSession === undefined) return
            run(face.interrupt(openSession.id, text))
          }}
        />
      )}
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
