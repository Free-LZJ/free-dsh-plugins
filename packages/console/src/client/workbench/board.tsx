/**
 * The board view: what needs a decision, who is on it, and what is finished.
 *
 * Three columns over one status strip. The strip is the first screen's answer to
 * "how much is on my plate" — 待处理 / 进行中 / 已处理 / 异常 — and every number
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
import type { ConsoleNoticeRecord, WorkbenchState, WorkbenchCard, WorkbenchColumn } from '../../protocol.ts'
import type { Translate } from '../locales.ts'
import { CLS } from '../styles.ts'
import {
  BoardCard, CardDetail, COLUMNS, columnDot, columnEmptyKey, columnHintKey, columnLabelKey,
} from './card.tsx'

/** Everything the board reads and calls, injected by the plugin's `apply`. */
export interface WorkbenchFace {
  /** Selector hook over the board state. */
  readonly useBoard: SnapshotSelectorHook<WorkbenchState | undefined>
  /** Selector hook over the workbench items, so a chain can list its notices too. */
  readonly useNotices: SnapshotSelectorHook<readonly ConsoleNoticeRecord[]>
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
 * 一条链路在板上的样子：同一件事的全部步骤，加上代表它的那张卡。
 *
 * 看板画的是它，不是 `WorkbenchCard`：一张卡一件事，这正是「同一件事被拆成好几张卡」
 * 的解药。代表卡负责标题/来源/优先级（根卡自己），状态取全簇最活跃的那一步。
 */
export interface BoardItem {
  /** 链路键：根卡 id。 */
  readonly rootId: string
  /** 代表卡：根卡；根卡不在时取最早的一步。 */
  readonly card: WorkbenchCard
  /** 全部步骤，按发生顺序。 */
  readonly steps: readonly WorkbenchCard[]
  /** 整条链落在哪一列：有步骤在跑就算进行中，否则有等待就算待处理。 */
  readonly column: WorkbenchColumn
  /** 全簇最新一次活动。 */
  readonly updatedAt: number
}

/** 列权重：只用来给一条链挑「最活跃」的那一列。 */
const COLUMN_WEIGHT: Record<WorkbenchColumn, number> = { processing: 2, todo: 1, done: 0 }

/**
 * 把卡片按 `rootId` 收成链路。
 *
 * 没有 `rootId` 的卡（老数据、外部直接造的事件）自成一链——升级不会把两件不相干
 * 的事悄悄并在一起，这也是这个方案敢自动分组的前提。
 * @param cards - 板上全部卡片。
 * @returns 每条链一项，顺序与输入里第一次出现相同。
 */
export function groupByChain(cards: readonly WorkbenchCard[]): readonly BoardItem[] {
  const groups = new Map<string, WorkbenchCard[]>()
  for (const card of cards) {
    const key = typeof card.rootId === 'string' && card.rootId !== '' ? card.rootId : card.id
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [card])
    else bucket.push(card)
  }
  const items: BoardItem[] = []
  for (const [rootId, bucket] of groups) {
    const steps = [...bucket].sort((left, right) => left.createdAt - right.createdAt)
    const card = steps.find(step => step.id === rootId) ?? steps[0]
    if (card === undefined) continue
    const column = steps.reduce<WorkbenchColumn>(
      (best, step) => (COLUMN_WEIGHT[step.column] > COLUMN_WEIGHT[best] ? step.column : best),
      'done',
    )
    const updatedAt = steps.reduce((newest, step) => Math.max(newest, step.updatedAt), 0)
    items.push({ rootId, card, steps, column, updatedAt })
  }
  return items
}

/**
 * What the board shows when the Host mounted none: a sentence, not an empty grid.
 * @param props.t - the translate seat.
 * @returns the empty state.
 */
export function WorkbenchUnavailable({ t }: { readonly t: Translate }): ReactNode {
  return <p className={CLS.empty}>{t('boardMissing')}</p>
}

/** The four figures the strip shows, all derived from the snapshot's chains. */
function statistics(items: readonly BoardItem[], now: number): {
  readonly todo: number
  readonly running: number
  readonly doneToday: number
  readonly failed: number
} {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const since = dayStart.getTime()
  return {
    todo: items.filter((item) => item.column === 'todo').length,
    running: items.filter((item) => item.column === 'processing').length,
    doneToday: items.filter((item) => item.column === 'done' && item.updatedAt >= since).length,
    failed: items.filter((item) => item.steps.some((step) => step.status === 'failed')).length,
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
  readonly cards: readonly BoardItem[]
}

/**
 * Group finished chains by the day they last moved.
 *
 * Q6 settled the shape: the column expands **today only**, and everything older
 * folds into one disclosure per day — a work desk that scrolls back a month is a
 * work desk nobody reads. Order is newest first inside a day, newest day first.
 * @param items - the finished chains.
 * @param now - the reading moment, so "today" means one thing per render.
 * @param t - the translate seat.
 * @returns the days, newest first.
 */
export function groupDoneByDay(
  items: readonly BoardItem[],
  now: number,
  t: Translate,
): readonly DoneDay[] {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const todayKey = dayKey(now)
  const yesterdayKey = dayKey(yesterday.getTime())
  const days = new Map<string, BoardItem[]>()
  for (const item of [...items].sort((left, right) => right.updatedAt - left.updatedAt)) {
    const key = dayKey(item.updatedAt)
    const bucket = days.get(key)
    if (bucket === undefined) days.set(key, [item])
    else bucket.push(item)
  }
  return [...days.entries()].map(([key, dayItems]) => ({
    key,
    label: key === todayKey
      ? t('dayToday')
      : key === yesterdayKey ? t('dayYesterday') : new Date(dayItems[0]?.updatedAt ?? now).toLocaleDateString(),
    cards: dayItems,
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
  const notices = face.useNotices((current) => current)
  /** The column a card is currently hovering over, so it can show it will take it. */
  const [over, setOver] = useState<WorkbenchColumn | undefined>(undefined)
  /** 打开的是哪条链路（按根卡 id），不是哪张卡：详情里要看的是一整件事。 */
  const [openRootId, setOpenRootId] = useState<string | undefined>(undefined)
  /** Why the last action did not take; empty means nothing failed. */
  const [failure, setFailure] = useState('')
  /** The days the user opened or closed in 已处理; absent means "today's default". */
  const [openedDays, setOpenedDays] = useState<Readonly<Record<string, boolean>>>({})
  /** The board root, used to read the visible card order for `j` / `k`. */
  const boardRef = useRef<HTMLDivElement>(null)

  if (state === undefined) return <p className={CLS.empty}>{t('boardLoading')}</p>
  // 空看板只说一次：状态条、三列空框与注意力队列的空态摞在一起，比「没活」本身更响。
  if (state.cards.length === 0) return <p className={CLS.empty}>{t('boardEmpty')}</p>

  const now = Date.now()
  const items = groupByChain(state.cards)
  const counts = statistics(items, now)
  const openItem = items.find((item) => item.rootId === openRootId)
  const openSession = openItem?.card.sessionId === undefined
    ? undefined
    : state.sessions.find((session) => session.id === openItem.card.sessionId)

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

  /** One list of chains, whichever column shape asked for it. */
  const cardList = (chains: readonly BoardItem[]): ReactNode => (
    <ul className={CLS.cardsList}>
      {chains.map((item) => (
        <li key={item.rootId}>
          <BoardCard
            card={item.card}
            stepCount={item.steps.length}
            t={t}
            now={now}
            onOpen={() => { setOpenRootId(item.rootId) }}
            onDispatch={() => { run(face.dispatch(item.card.id, item.card.executor)) }}
            onMove={(next) => { run(face.move(item.card.id, next)) }}
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
          const chains = items.filter((item) => item.column === column)
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
                  <span className={CLS.columnCount}>{chains.length}</span>
                </div>
                <p className={CLS.columnHint}>{t(columnHintKey(column))}</p>
              </header>
              {chains.length === 0
                ? <p className={CLS.columnEmpty}>{t(columnEmptyKey(column))}</p>
                : column === 'done'
                  ? (
                    // 已处理按天折叠（Q6）：今天展开，更早的每天一行，点开才列。
                    // 只有一天（且就是今天）时不分组——那层折叠只在一列真有历史时才有意义。
                    doneColumn(chains, now, t, cardList, isDayOpen, toggleDay)
                  )
                  : cardList(chains)}
            </section>
          )
        })}
      </div>
      {/* 这条注脚说的是数据从哪来、哪里还不真，属于脚注而不是抬头，排在列下面。 */}
      <p className={CLS.boardHint}>{t('boardHint')}</p>
      {openItem !== undefined && (
        <CardDetail
          card={openItem.card}
          steps={openItem.steps}
          // 通知也是这件事的一步：按根归拢，没有根的老通知不硬塞进别人的链路。
          notices={notices.filter((notice) => notice.rootId === openItem.rootId)}
          {...(openSession === undefined ? {} : { session: openSession })}
          t={t}
          now={now}
          onClose={() => { setOpenRootId(undefined) }}
          onDispatch={() => { run(face.dispatch(openItem.card.id, openItem.card.executor)) }}
          onMove={(column) => { run(face.move(openItem.card.id, column)) }}
          onConfirm={() => { run(face.confirm(openItem.card.id)) }}
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
  chains: readonly BoardItem[],
  now: number,
  t: Translate,
  cardList: (chains: readonly BoardItem[]) => ReactNode,
  isOpen: (key: string) => boolean,
  toggle: (key: string) => void,
): ReactNode {
  const days = groupDoneByDay(chains, now, t)
  if (days.length === 1 && days[0]?.key === dayKey(now)) return cardList(chains)
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
