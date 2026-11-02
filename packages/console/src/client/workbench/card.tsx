/**
 * One board card, its action bar, and the detail dialog behind it.
 *
 * The card is the five-row anatomy the design brief settled on (§6.2): where it
 * came from and what it is keyed by; the title; the description; the
 * classification with its confidence and the rule version that decided; then the
 * executor, the status and when it last moved. Above that bar there is one hard
 * rule worth restating: **status is always text**, never a colour dot on its
 * own — a work desk you cannot read at a glance is a work desk you stop
 * trusting.
 *
 * Everything a pointer can do the keyboard can do too. Dragging a card between
 * columns is a convenience; the "move to…" menu is the path that always works,
 * and it is a shared `Menu`, so its arrow keys and focus return are the
 * framework's rather than a second implementation.
 *
 * @module @free-lzj/dsh-console/client/workbench/card
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Menu, MenuItemButton, Modal, RiskConfirmation, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConsoleNoticeRecord, WorkbenchCard, WorkbenchColumn, WorkbenchReason, WorkbenchSession,
} from '../../protocol.ts'
import { REASON_KEYS, kindLabel, sourceLabel, type Translate } from '../locales.ts'
import { CLS } from '../styles.ts'

/** The columns, in board order. */
export const COLUMNS: readonly WorkbenchColumn[] = ['todo', 'processing', 'done']

/** Locale key naming one column. */
export function columnLabelKey(column: WorkbenchColumn): Parameters<Translate>[0] {
  return column === 'processing' ? 'boardProcessing' : column === 'done' ? 'boardDone' : 'boardTodo'
}

/** Locale key for the one-line explanation under a column's name. */
export function columnHintKey(column: WorkbenchColumn): Parameters<Translate>[0] {
  return column === 'processing' ? 'boardProcessingHint' : column === 'done' ? 'boardDoneHint' : 'boardTodoHint'
}

/** Locale key for a column's empty state. */
export function columnEmptyKey(column: WorkbenchColumn): Parameters<Translate>[0] {
  return column === 'processing' ? 'boardProcessingEmpty' : column === 'done' ? 'boardDoneEmpty' : 'boardTodoEmpty'
}

/** The dot a column flies under; the label next to it carries the meaning. */
export function columnDot(column: WorkbenchColumn): 'idle' | 'ongoing' | 'done' {
  return column === 'processing' ? 'ongoing' : column === 'done' ? 'done' : 'idle'
}

/** Locale key naming one card status. */
function statusKey(status: WorkbenchCard['status']): Parameters<Translate>[0] {
  switch (status) {
    case 'running': return 'statusRunning'
    case 'waiting-input': return 'statusWaiting'
    case 'paused': return 'statusPaused'
    case 'done': return 'statusDone'
    case 'failed': return 'statusFailed'
    default: return 'statusIdle'
  }
}

/** The dot paired with that status text. */
function statusDot(status: WorkbenchCard['status']): 'idle' | 'ongoing' | 'warning' | 'done' | 'error' {
  switch (status) {
    case 'running': return 'ongoing'
    case 'waiting-input': return 'warning'
    case 'done': return 'done'
    case 'failed': return 'error'
    default: return 'idle'
  }
}

/** Locale key naming one priority. */
function priorityKey(priority: WorkbenchCard['priority']): Parameters<Translate>[0] {
  switch (priority) {
    case 'urgent': return 'priorityUrgent'
    case 'high': return 'priorityHigh'
    case 'low': return 'priorityLow'
    default: return 'priorityNormal'
  }
}

/** The tag tone a priority wears; urgency is the only one that shouts. */
function priorityTone(priority: WorkbenchCard['priority']): 'quiet' | 'neutral' | 'warning' | 'danger' {
  switch (priority) {
    case 'urgent': return 'danger'
    case 'high': return 'warning'
    case 'low': return 'quiet'
    default: return 'neutral'
  }
}

/** The confidence band the brief set: ≥85 neutral, 60–85 warn, <60 error. */
function confidenceTone(confidence: number): 'neutral' | 'warning' | 'danger' {
  if (confidence >= 0.85) return 'neutral'
  if (confidence >= 0.6) return 'warning'
  return 'danger'
}

/** Below this confidence the card was held for a human instead of dispatched. */
const HOLD_THRESHOLD = 0.6

/**
 * How long ago something happened, in the coarse units a card has room for.
 * @param at - the instant, epoch ms.
 * @param now - the reading moment, so one render agrees with itself.
 * @param t - the translate seat.
 * @returns the localized phrase.
 */
export function relativeTime(at: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return t('minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hoursAgo', { count: hours })
  return t('daysAgo', { count: Math.floor(hours / 24) })
}

/**
 * The "move to…" menu: the keyboard path for what dragging does.
 *
 * `columns` is filtered by the caller so the card never offers to move itself
 * where it already is.
 * @param props.card - the card being moved.
 * @param props.t - the translate seat.
 * @param props.onMove - called with the destination column.
 * @returns the trigger button and its menu.
 */
function MoveMenu(props: {
  readonly card: WorkbenchCard
  readonly t: Translate
  readonly onMove: (column: WorkbenchColumn) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const targets = COLUMNS.filter((column) => column !== props.card.column)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      align="end"
      portal
      anchor={(
        <Button
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={props.t('cardMove')}
          onClick={() => { setOpen((value) => !value) }}
        >
          {props.t('cardMove')}
        </Button>
      )}
    >
      {targets.map((column) => (
        <MenuItemButton
          key={column}
          onSelect={() => {
            setOpen(false)
            props.onMove(column)
          }}
        >
          {props.t(columnLabelKey(column))}
        </MenuItemButton>
      ))}
    </Menu>
  )
}

/** What one card needs to draw itself and to act. */
export interface BoardCardProps {
  readonly card: WorkbenchCard
  /** 这条链路有几张卡；1 表示它就是一件事的全部，不显示步数。 */
  readonly stepCount: number
  readonly t: Translate
  /** The single "now" of this render, so every relative time agrees. */
  readonly now: number
  readonly onOpen: () => void
  readonly onDispatch: () => void
  readonly onMove: (column: WorkbenchColumn) => void
  /** Clear any drag-over highlight: the drag ended, wherever it ended. */
  readonly onDragEnd: () => void
}

/**
 * Draw one card.
 * @param props - the card, the translate seat, and what the actions do.
 * @returns the card.
 */
export function BoardCard({ card, stepCount, t, now, onOpen, onDispatch, onMove, onDragEnd }: BoardCardProps): ReactNode {
  const confidence = Math.round(card.confidence * 100)
  const executor = card.executor ?? t('cardNoExecutor')
  return (    <article
      className={CLS.boardCard}
      aria-label={card.title}
      data-card-id={card.id}
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        // Enter opens the detail dialog; buttons inside the card keep their own.
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div className={CLS.cardFrom}>
        <Tag tone="outline">{sourceLabel(card.source, t)}</Tag>
        {card.externalId !== undefined && <span className={CLS.cardRef}>{card.externalId}</span>}
        <span className={CLS.cardPriority}>
          <Tag tone={priorityTone(card.priority)}>{t(priorityKey(card.priority))}</Tag>
        </span>
      </div>
      <h4 className={CLS.boardCardTitle}>{card.title}</h4>
      {card.body !== undefined && card.body !== '' && <p className={CLS.boardCardBody}>{card.body}</p>}
      <div className={CLS.cardFacts}>
        <Tag tone="neutral">{kindLabel(card.kind, t)}</Tag>
        <Tag tone={confidenceTone(card.confidence)}>{t('cardConfidence', { value: confidence })}</Tag>
        {stepCount > 1 && <Tag tone="info">{t('chainSteps', { count: stepCount })}</Tag>}
      </div>
      {card.confidence < HOLD_THRESHOLD && <p className={CLS.cardNote}>{t('cardLowConfidence')}</p>}
      <div className={CLS.cardFoot}>
        <span className={CLS.cardExecutor}>{executor}</span>
        <StateDot state={statusDot(card.status)} />
        <span className={CLS.cardStatus}>{t(statusKey(card.status))}</span>
        <span className={CLS.cardWhen}>{relativeTime(card.updatedAt, now, t)}</span>
      </div>
      {/*
        Visible on hover and on keyboard focus (`.card:focus-within`), the way the
        home cards already behave — the bar stays in the tab order either way, so
        nothing here is pointer-only.
      */}
      <div className={CLS.cardBar}>
        {card.column === 'todo' && (
          <Button size="sm" onClick={onDispatch}>{t('cardDispatch')}</Button>
        )}
        <Button size="sm" onClick={onOpen}>{t('cardDetail')}</Button>
        <MoveMenu card={card} t={t} onMove={onMove} />
      </div>
    </article>
  )
}

/**
 * Word one line of the audit trail.
 *
 * Three fallbacks, in order: the page's own locale for the code, the sentence an
 * older build stored on the card, then one generic line. None of them is the raw
 * code — a card's history is read by people, not by the code that wrote it.
 * @param reason - the stored line.
 * @param t - the translate seat.
 * @returns the sentence to show.
 */
export function reasonText(reason: WorkbenchReason, t: Translate): string {
  if (reason.code === 'legacy' && reason.text !== undefined) return reason.text
  const key = REASON_KEYS[reason.code]
  if (key !== undefined) return t(key, reason.params)
  return reason.text === undefined ? t('reasonUnknown') : reason.text
}

/**
 * Drop the reasons written twice.
 *
 * Routing and classification each record their own copy of some lines, so the
 * concatenation shows the same sentence twice. Comparing `code` + parameters —
 * not the rendered sentence — keeps two reasons with different parameters apart,
 * and survives re-wording in a locale.
 * @param reasons - both reason lists, in display order.
 * @returns the list without duplicates, order preserved.
 */
export function dedupeReasons(reasons: readonly WorkbenchReason[]): readonly WorkbenchReason[] {
  const seen = new Set<string>()
  return reasons.filter((reason) => {
    const params = reason.params ?? {}
    const key = `${reason.code}:${Object.keys(params).sort().map(name => `${name}=${String(params[name])}`).join('&')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** What the detail dialog reads and does. */
export interface CardDetailProps {
  readonly card: WorkbenchCard
  /**
   * 同一件事的全部步骤（含 `card` 自己），按发生顺序。
   *
   * 看板上一张链路卡，详情里就是这一列——这就是「同一件事别再拆成好几张卡」的落点。
   */
  readonly steps: readonly WorkbenchCard[]
  /** 挂在这条链路上的通知；它们不是卡，但也是这件事的一步。 */
  readonly notices?: readonly ConsoleNoticeRecord[]
  /** The session this card dispatched, when it has one. */
  readonly session?: WorkbenchSession
  readonly t: Translate
  readonly now: number
  readonly onClose: () => void
  readonly onDispatch: () => void
  readonly onMove: (column: WorkbenchColumn) => void
  readonly onInterrupt: (text: string) => void
  /** 停止这一轮：真实会话走 `cancel()`，卡片随后落到失败并带原因。 */
  readonly onStop: () => void
  /** Mark the card written back; only shown on a finished card still awaiting it. */
  readonly onConfirm: () => void
  /** 把推断进来的某个成员拆开：推断会合错，这一步必须能撤销。 */
  readonly onDetach: (cardId: string) => void
}

/**
 * Draw one card's detail dialog: what was decided, why, when, and what can be
 * done about it.
 *
 * DSH has no drawer primitive, so this is the shared `Modal` with the card's
 * facts laid out inside it. The chain is the one place a piece of work can be
 * audited from, which is why it is here and not on the card: on the board the
 * whole thing has to fit in one card.
 * @param props - the card, its chain, and the actions.
 * @returns the dialog.
 */
export function CardDetail(props: CardDetailProps): ReactNode {
  const { card, steps, t, now } = props
  const [draft, setDraft] = useState('')
  /** 停止确认的开合与勾选：中断一轮对话不是一次随手可撤销的点击。 */
  const [stopOpen, setStopOpen] = useState(false)
  const [stopAcknowledged, setStopAcknowledged] = useState(false)
  /**
   * 重播计数。
   *
   * 动画靠重挂载重放（`key`），而不是靠一个「正在播放」的布尔：重挂载天然从
   * 第一帧重来，也不需要清定时器。
   */
  const [replay, setReplay] = useState(0)
  /**
   * 判断依据去重。
   *
   * 路由与分类各记了一遍同一条理由（同一件事被两处写下），拼起来就是同一句话连着
   * 出现两次。去重按 code + 参数，不按渲染后的文字——文字是可翻译的，比较文字会把
   * 两条参数不同的理由误并成一条。
   */
  const reasons = dedupeReasons([...card.decision.reasons, ...card.decision.classification.reasons])
  const notices = props.notices ?? []
  return (
    <Modal
      open
      className={CLS.cardDetailDialog}
      contentClassName={CLS.cardDetailScroll}
      onClose={props.onClose}
      title={card.title}
      description={`${t('detailSource')}: ${sourceLabel(card.source, t)}${card.externalId === undefined ? '' : ` · ${card.externalId}`}`}
      closeLabel={t('close')}
      footer={(
        <>
          {/* 动作全在底栏：正文只放信息，读和做不混在一列里。 */}
          <div className={CLS.cardDetailFooterStart}>
            {COLUMNS.filter((column) => column !== card.column).map((column) => (
              <Button key={column} size="sm" onClick={() => { props.onMove(column) }}>
                {t('moveTo', { target: t(columnLabelKey(column)) })}
              </Button>
            ))}
            {card.column === 'done' && card.awaitingConfirmation && (
              <Button variant="outline" size="sm" onClick={props.onConfirm}>{t('cardConfirm')}</Button>
            )}
          </div>
          {card.column === 'todo' && <Button variant="primary" onClick={props.onDispatch}>{t('cardDispatch')}</Button>}
          <Button onClick={props.onClose}>{t('close')}</Button>
        </>
      )}
    >
      {/*
        两栏：左边是「这件事是什么」（分类、规则、判断依据），右边是「它怎么走到现在」
        （链路 + 会话）。窄屏回落单列——两栏在 600px 以下只会互相挤。
      */}
      <div className={CLS.cardDetailColumns}>
        <section className={CLS.cardDetailSide}>
          <h3 className={CLS.detailHeading}>{t('detailTitle')}</h3>
          <dl className={CLS.detailList}>
            <dt>{t('detailKind')}</dt>
            <dd>{kindLabel(card.kind, t)}</dd>
            <dt>{t('detailPriority')}</dt>
            <dd>{t(priorityKey(card.priority))}</dd>
            <dt>{t('detailConfidence')}</dt>
            <dd>{Math.round(card.confidence * 100)}%</dd>
            <dt>{t('detailExecutor')}</dt>
            <dd>{card.executor ?? t('cardNoExecutor')}</dd>
            <dt>{t('detailRoute')}</dt>
            <dd>{card.decision.routeId} · {card.decision.ruleVersion}</dd>
          </dl>
          <h3 className={CLS.detailHeading}>{t('detailReasons')}</h3>
          {reasons.length === 0
            ? <p className={CLS.detailNote}>{t('detailNoReasons')}</p>
            : (
              <ul className={CLS.detailReasons}>
                {reasons.map((reason, index) => (
                  <li key={`${index}-${reason.code}`} className={CLS.detailReason}>{reasonText(reason, t)}</li>
                ))}
              </ul>
            )}
        </section>
        <section className={CLS.cardDetailMain}>
          <h3 className={CLS.detailHeading}>{t('detailChain')}</h3>
          {/*
            一条链路一列：步骤按发生顺序，CSS 依次点亮（`animation-delay`），点「重播」
            重挂载再走一遍。不用动画库、不用定时器——播放完毕就是静态可读的一列。
          */}
          <ol className={CLS.steps} key={replay}>
            {steps.map((step, index) => (
              <li
                key={step.id}
                className={CLS.step}
                style={{ animationDelay: `${String(index * 110)}ms` }}
              >
                <span className={CLS.stepIndex}>{index + 1}</span>
                <span className={CLS.stepBody}>
                  <span className={CLS.stepTitle}>{step.title}</span>
                  <span className={CLS.stepMeta}>
                    <Tag tone="outline">{sourceLabel(step.source, t)}</Tag>
                    <StateDot state={statusDot(step.status)} />
                    <span>{t(statusKey(step.status))}</span>
                  </span>
                </span>
                {/* 时间独立成列（grid 第三列）：塞在 meta 里会跟着标题长度飘。 */}
                <span className={CLS.stepTail}>
                  <span className={CLS.stepWhen}>{relativeTime(step.createdAt, now, t)}</span>
                  {step.chainInferred === true && step.id !== card.rootId && (
                    <Button size="sm" variant="ghost" onClick={() => { props.onDetach(step.id) }}>
                      {t('chainDetach')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
            {notices.map((notice, index) => (
              <li
                key={notice.id}
                className={`${CLS.step} ${CLS.stepNotice}`}
                style={{ animationDelay: `${String((steps.length + index) * 110)}ms` }}
              >
                <span className={CLS.stepIndex}>{steps.length + index + 1}</span>
                <span className={CLS.stepBody}>
                  <span className={CLS.stepTitle}>{notice.title}</span>
                  <span className={CLS.stepMeta}>
                    <Tag tone="outline">{t('detailNoticeStep')}</Tag>
                    <span>{t(notice.state === 'resolved' ? 'noticeDone' : notice.state === 'dismissed' ? 'noticeDismissed' : 'noticeSnoozed')}</span>
                  </span>
                </span>
                <span className={CLS.stepWhen}>{relativeTime(notice.createdAt, now, t)}</span>
              </li>
            ))}
          </ol>
          <div className={CLS.detailChainFoot}>
            <p className={CLS.detailNote}>{t('detailChainHint')}</p>
            <Button size="sm" onClick={() => { setReplay((value) => value + 1) }}>{t('detailReplay')}</Button>
          </div>
          {steps.some((step) => step.chainInferred === true) && (
            // 推断合并必须让人知道，否则「它们为什么在一起」会变成一次信任事故。
            <p className={CLS.detailNote}>{t('chainInferredHint')}</p>
          )}
          {props.session !== undefined && (
            <>
              <h3 className={CLS.detailHeading}>{t('sessionTitle')}</h3>
              <div className={CLS.sessionBox}>
                <div className={CLS.cardFoot}>
                  <StateDot state={statusDot(card.status)} />
                  <span>{t(statusKey(card.status))}</span>
                  <span className={CLS.cardWhen}>{relativeTime(props.session.updatedAt, now, t)}</span>
                </div>
                <h4 className={CLS.sessionLogTitle}>{t('sessionLog')}</h4>
                <SessionLog t={t} lines={props.session.logs} />
                {/*
                  Q5: the focus depth is read + interrupt only. Pause and end need the
                  interrupt semantics settled first, so they stay off the page.
                */}
                <div className={CLS.row}>
                  <Input
                    value={draft}
                    placeholder={t('interruptPlaceholder')}
                    aria-label={t('interruptPlaceholder')}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <Button
                    onClick={() => {
                      if (draft.trim() === '') return
                      props.onInterrupt(draft.trim())
                      setDraft('')
                    }}
                  >
                    {t('interruptSend')}
                  </Button>
                  {/* 停止是「这一轮不要了」，与插话是两种意图：一个催它、一个拦它。 */}
                  <Button variant="outline" onClick={() => { setStopOpen(true) }}>{t('sessionStop')}</Button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
      <RiskConfirmation
        open={stopOpen}
        title={t('stopConfirmTitle')}
        description={t('stopConfirmBody')}
        acknowledgeLabel={t('stopConfirmAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={t('sessionStop')}
        acknowledged={stopAcknowledged}
        onAcknowledgedChange={setStopAcknowledged}
        onCancel={() => {
          setStopOpen(false)
          setStopAcknowledged(false)
        }}
        onConfirm={() => {
          setStopOpen(false)
          setStopAcknowledged(false)
          props.onStop()
        }}
      />
    </Modal>
  )
}
/**
 * One session's log, kept on the newest line.
 *
 * A run prints while the dialog is open, and a log that stays scrolled to the top
 * makes the newest line the one nobody sees. Following is unconditional (`el` is
 * scrolled on every append) — a user who scrolled up to read history should not be
 * yanked back, but the board's logs are short and append-only, so the simpler
 * behaviour wins until someone asks otherwise.
 * @param props.t - the translate seat.
 * @param props.lines - the lines, oldest first.
 * @returns the log list, or a note when nothing has been printed yet.
 */
function SessionLog(props: { readonly t: Translate; readonly lines: readonly { readonly at: number; readonly text: string }[] }): ReactNode {
  const ref = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    const element = ref.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [props.lines.length])
  if (props.lines.length === 0) return <p className={CLS.detailNote}>{props.t('sessionLogEmpty')}</p>
  return (
    <ul className={CLS.sessionLog} ref={ref}>
      {props.lines.map((line, index) => (
        <li key={`${line.at}-${index}`} className={CLS.logLine}>{line.text}</li>
      ))}
    </ul>
  )
}