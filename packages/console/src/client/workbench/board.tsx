/**
 * The board, browser half: three columns, the cards on them, and the session
 * focus view.
 *
 * The shape follows the delivered prototype and the design brief: cards carry
 * source, priority, classification confidence, executor, and live status;
 * dragging a card into `processing` (or pressing its dispatch button) starts
 * a session; the focus view below the columns shows the selected session's
 * log and takes interrupt, pause, resume, and end. There is deliberately no
 * diff-review gate here — the user shelved it for v0 — so a finished card
 * lands in `done` marked as awaiting confirmation, and nothing here writes
 * back to any outside system.
 *
 * The face is injected by the plugin's `apply`, so a spec drives this view
 * with a fake face and never touches the network.
 *
 * @module @free-lzj/dsh-console/client/workbench/board
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkbenchCard, WorkbenchColumn, WorkbenchSession, WorkbenchState,
} from '../../protocol.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { Translate } from '../locales.ts'
import { CLS } from '../styles.ts'
import { WorkbenchMeta, WorkbenchSimulator } from './simulator.tsx'

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

/** The columns, in board order. */
const COLUMNS: readonly WorkbenchColumn[] = ['todo', 'processing', 'done']

/**
 * Draw the board section of the workbench home.
 * @param props - the injected face and the translate seat.
 * @returns the board, the session focus view, the simulator, and the meta lists.
 */
export function WorkbenchSection(props: { face: WorkbenchFace; t: Translate }): ReactNode {
  const { face, t } = props
  const state = face.useBoard((current) => current)
  const [dragged, setDragged] = useState<string | undefined>(undefined)
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined)

  if (state === undefined) {
    return (
      <section className={CLS.wbRoot} aria-label={t('boardTitle')}>
        <h2 className={CLS.wbTitle}>{t('boardTitle')}</h2>
        <p className={CLS.wbEmpty}>{t('boardLoading')}</p>
      </section>
    )
  }

  const selected = state.sessions.find((session) => session.id === selectedSessionId)
    ?? state.sessions.find((session) => session.status === 'running' || session.status === 'paused')

  return (
    <section className={CLS.wbRoot} aria-label={t('boardTitle')}>
      <h2 className={CLS.wbTitle}>{t('boardTitle')}</h2>
      <p className={CLS.wbHint}>{t('boardHint')}</p>
      <div className={CLS.wbColumns}>
        {COLUMNS.map((column) => (
          <div
            key={column}
            className={CLS.wbColumn}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              if (dragged !== undefined) void face.move(dragged, column)
              setDragged(undefined)
            }}
          >
            <h3 className={CLS.wbColumnTitle}>
              {t(column === 'todo' ? 'boardTodo' : column === 'processing' ? 'boardProcessing' : 'boardDone')}
              {' '}
              ({state.cards.filter((card) => card.column === column).length})
            </h3>
            <ul className={CLS.wbCards}>
              {state.cards.filter((card) => card.column === column).map((card) => (
                <li key={card.id}>
                  <article
                    className={CLS.wbCard}
                    draggable
                    onDragStart={() => setDragged(card.id)}
                    onDragEnd={() => setDragged(undefined)}
                  >
                    <div className={CLS.wbCardTitle}>{card.title}</div>
                    <div className={CLS.wbCardMeta}>
                      <Tag>{card.source}</Tag>
                      <Tag>{card.kind}</Tag>
                      <Tag>{t('cardConfidence', { value: Math.round(card.confidence * 100) })}</Tag>
                      {card.executor !== undefined && <Tag>{card.executor}</Tag>}
                      <Tag>{t(cardStatusKey(card.status))}</Tag>
                      {card.awaitingConfirmation && <Tag>{t('cardAwaiting')}</Tag>}
                    </div>
                    {card.column === 'todo' && (
                      <div className={CLS.wbCardActions}>
                        <Button onClick={() => void face.dispatch(card.id, card.executor)}>
                          {t('cardDispatch')}
                        </Button>
                      </div>
                    )}
                    {card.sessionId !== undefined && (
                      <div className={CLS.wbCardActions}>
                        <Button onClick={() => setSelectedSessionId(card.sessionId)}>
                          {t('sessionFocus')}
                        </Button>
                      </div>
                    )}
                  </article>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <SessionFocus
        face={face}
        t={t}
        sessions={state.sessions}
        selected={selected}
        onSelect={setSelectedSessionId}
      />
      <WorkbenchSimulator face={face} t={t} />
      <WorkbenchMeta state={state} t={t} />
    </section>
  )
}

/**
 * Draw the session focus view: the session picker, the live log, and the
 * interrupt / pause / resume / end controls.
 */
function SessionFocus(props: {
  face: WorkbenchFace
  t: Translate
  sessions: readonly WorkbenchSession[]
  selected: WorkbenchSession | undefined
  onSelect: (id: string) => void
}): ReactNode {
  const { face, t, sessions, selected, onSelect } = props
  const [draft, setDraft] = useState('')

  return (
    <div className={CLS.wbSession}>
      <h3 className={CLS.wbSubtitle}>{t('sessionTitle')}</h3>
      {sessions.length === 0 && <p className={CLS.wbEmpty}>{t('sessionEmpty')}</p>}
      <div className={CLS.wbSessionList}>
        {sessions.map((session) => (
          <Button
            key={session.id}
            onClick={() => onSelect(session.id)}
          >
            {session.executor} · {t(sessionStatusKey(session.status))} · {session.cardId.slice(0, 8)}
          </Button>
        ))}
      </div>
      {selected !== undefined && (
        <div>
          <ul className={CLS.wbLogs}>
            {selected.logs.map((line, index) => (
              <li key={`${line.at}-${index}`} className={CLS.wbLog}>
                {line.text}
              </li>
            ))}
          </ul>
          <div className={CLS.wbRow}>
            <Input
              value={draft}
              placeholder={t('interruptPlaceholder')}
              aria-label={t('interruptPlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              onClick={() => {
                if (draft.trim() === '') return
                void face.interrupt(selected.id, draft.trim())
                setDraft('')
              }}
            >
              {t('interruptSend')}
            </Button>
            {selected.status === 'running' && (
              <Button onClick={() => void face.pause(selected.id)}>{t('sessionPause')}</Button>
            )}
            {selected.status === 'paused' && (
              <Button onClick={() => void face.resume(selected.id)}>{t('sessionResume')}</Button>
            )}
            {(selected.status === 'running' || selected.status === 'paused') && (
              <Button onClick={() => void face.end(selected.id)}>{t('sessionEnd')}</Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Locale key for one card status. */
function cardStatusKey(status: WorkbenchCard['status']): Parameters<Translate>[0] {
  switch (status) {
    case 'running': return 'statusRunning'
    case 'waiting-input': return 'statusWaiting'
    case 'paused': return 'statusPaused'
    case 'done': return 'statusDone'
    case 'failed': return 'statusFailed'
    default: return 'statusIdle'
  }
}

/** Locale key for one session status. */
function sessionStatusKey(status: WorkbenchSession['status']): Parameters<Translate>[0] {
  switch (status) {
    case 'running': return 'statusRunning'
    case 'paused': return 'statusPaused'
    case 'done': return 'statusDone'
    case 'failed': return 'statusFailed'
    default: return 'statusEnded'
  }
}
