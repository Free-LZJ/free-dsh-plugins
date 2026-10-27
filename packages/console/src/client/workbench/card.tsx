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

import { useState, type ReactNode } from 'react'
import { Button, Input, Menu, MenuItemButton, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchCard, WorkbenchColumn, WorkbenchReason, WorkbenchSession } from '../../protocol.ts'
import { REASON_KEYS, type Translate } from '../locales.ts'
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

/** Locale key naming one source. */
function sourceKey(source: WorkbenchCard['source']): Parameters<Translate>[0] {
  switch (source) {
    case 'mail': return 'sourceMail'
    case 'webhook': return 'sourceWebhook'
    case 'dingtalk': return 'sourceDingtalk'
    case 'jira': return 'sourceJira'
    default: return 'sourceManual'
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
export function BoardCard({ card, t, now, onOpen, onDispatch, onMove, onDragEnd }: BoardCardProps): ReactNode {
  const confidence = Math.round(card.confidence * 100)
  const executor = card.executor ?? t('cardNoExecutor')
  return (
    <article
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
        <Tag tone="outline">{t(sourceKey(card.source))}</Tag>
        {card.externalId !== undefined && <span className={CLS.cardRef}>{card.externalId}</span>}
        <span className={CLS.cardPriority}>
          <Tag tone={priorityTone(card.priority)}>{t(priorityKey(card.priority))}</Tag>
        </span>
      </div>
      <h4 className={CLS.boardCardTitle}>{card.title}</h4>
      {card.body !== undefined && card.body !== '' && <p className={CLS.boardCardBody}>{card.body}</p>}
      <div className={CLS.cardFacts}>
        <Tag tone="neutral">{card.kind}</Tag>
        <Tag tone={confidenceTone(card.confidence)}>{t('cardConfidence', { value: confidence })}</Tag>
        <span className={CLS.cardVersion}>{t('cardRuleVersion', { version: card.decision.ruleVersion })}</span>
      </div>
      {card.confidence < HOLD_THRESHOLD && <p className={CLS.cardNote}>{t('cardLowConfidence')}</p>}
      <div className={CLS.cardFoot}>
        <span className={CLS.cardAvatar} aria-hidden="true">{executor.slice(0, 1).toUpperCase()}</span>
        <span className={CLS.cardExecutor}>{executor}</span>
        <StateDot state={statusDot(card.status)} />
        <span>{t(statusKey(card.status))}</span>
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

/** What the detail dialog reads and does. */
export interface CardDetailProps {
  readonly card: WorkbenchCard
  /** The session this card dispatched, when it has one. */
  readonly session?: WorkbenchSession
  readonly t: Translate
  readonly now: number
  readonly onClose: () => void
  readonly onDispatch: () => void
  readonly onMove: (column: WorkbenchColumn) => void
  readonly onInterrupt: (text: string) => void
  /** Mark the card written back; only shown on a finished card still awaiting it. */
  readonly onConfirm: () => void
}

/**
 * Draw one card's detail dialog: what was decided, why, when, and what can be
 * done about it.
 *
 * DSH has no drawer primitive, so this is the shared `Modal` with the card's
 * facts laid out inside it. The timeline is the one place a card can be
 * audited from, which is why it is here and not on the card.
 * @param props - the card, its session, and the actions.
 * @returns the dialog.
 */
export function CardDetail(props: CardDetailProps): ReactNode {
  const { card, session, t, now } = props
  const [draft, setDraft] = useState('')
  const reasons = [...card.decision.reasons, ...card.decision.classification.reasons]
  const status = t(statusKey(card.status))
  return (
    <Modal
      open
      onClose={props.onClose}
      title={card.title}
      description={`${t('detailSource')}: ${t(sourceKey(card.source))}${card.externalId === undefined ? '' : ` · ${card.externalId}`}`}
      closeLabel={t('close')}
      footer={(
        <>
          {card.column === 'todo' && <Button variant="primary" onClick={props.onDispatch}>{t('cardDispatch')}</Button>}
          {card.column === 'done' && card.awaitingConfirmation && (
            <Button variant="primary" onClick={props.onConfirm}>{t('cardConfirm')}</Button>
          )}
          <Button onClick={props.onClose}>{t('close')}</Button>
        </>
      )}
    >
      <h3 className={CLS.detailHeading}>{t('detailTitle')}</h3>
      <dl className={CLS.detailList}>
        <dt>{t('detailKind')}</dt>
        <dd>{card.kind}</dd>
        <dt>{t('detailPriority')}</dt>
        <dd>{t(priorityKey(card.priority))}</dd>
        <dt>{t('detailConfidence')}</dt>
        <dd>{t('cardConfidence', { value: Math.round(card.confidence * 100) })}</dd>
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
      <h3 className={CLS.detailHeading}>{t('detailTimeline')}</h3>
      <ol className={CLS.timeline}>
        <li className={CLS.timelineItem}>
          {t('timelineCreated')} · {new Date(card.createdAt).toLocaleString()} · {relativeTime(card.createdAt, now, t)}
        </li>
        <li className={CLS.timelineItem}>
          {t('timelineClassified', { kind: card.kind, route: card.decision.routeId })} · {card.decision.ruleVersion}
        </li>
        <li className={CLS.timelineItem}>
          {t('timelineLast', { status })} · {new Date(card.updatedAt).toLocaleString()}
        </li>
      </ol>
      <p className={CLS.detailNote}>{t('detailTimelineSource')}</p>
      {session !== undefined && (
        <>
          <h3 className={CLS.detailHeading}>{t('sessionTitle')}</h3>
          <div className={CLS.sessionBox}>
            <div className={CLS.cardFoot}>
              <StateDot state={statusDot(card.status)} />
              <span>{t(statusKey(card.status))}</span>
              <span className={CLS.cardWhen}>{relativeTime(session.updatedAt, now, t)}</span>
            </div>
            <h4 className={CLS.sessionLogTitle}>{t('sessionLog')}</h4>
            {session.logs.length === 0
              ? <p className={CLS.detailNote}>{t('sessionLogEmpty')}</p>
              : (
                <ul className={CLS.sessionLog}>
                  {session.logs.map((line, index) => (
                    <li key={`${line.at}-${index}`} className={CLS.logLine}>{line.text}</li>
                  ))}
                </ul>
              )}
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
            </div>
          </div>
        </>
      )}
      <h3 className={CLS.detailHeading}>{t('detailActions')}</h3>
      <div className={CLS.detailActions}>
        {COLUMNS.filter((column) => column !== card.column).map((column) => (
          <Button key={column} size="sm" onClick={() => props.onMove(column)}>
            {t('moveTo', { target: t(columnLabelKey(column)) })}
          </Button>
        ))}
      </div>
    </Modal>
  )
}
