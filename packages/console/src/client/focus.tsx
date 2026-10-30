/**
 * The focus page — the workbench's second main panel.
 *
 * It lists the sessions the platform already knows are working right now, with a
 * title, a working directory, and a way into the conversation. The other two
 * questions a work desk asks — who is waiting on you, and what finished without
 * being looked at — are answered where they are owned: the attention queue on
 * the board, and the board cards that still await write-back.
 *
 * @module @free-lzj/dsh-console/client/focus
 */

import { useState, type ReactNode } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunningSession, WorkbenchCard } from '../protocol.ts'
import type { WorkbenchFace } from './workbench/board.tsx'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

/** One navigation attempt: succeeded, or why not. */
interface OpenOutcome {
  readonly ok: boolean
  readonly message?: string
}

/**
 * Name one session without ever showing a bare UUID.
 * @param session - the session row.
 * @param t - the translate seat.
 * @returns the stored title, or a short id inside a sentence.
 */
export function sessionLabel(session: RunningSession, t: Translate): string {
  const title = session.title.trim()
  if (title !== '') return title
  return t('unnamedSession', { id: session.sessionId.slice(0, 8) })
}

/**
 * Draw the focus page.
 * @param props.t - the translate seat.
 * @param props.running - the sessions working right now, read from the Host snapshot.
 * @returns the page body.
 */
export function FocusPage(props: {
  readonly t: Translate
  readonly running: () => readonly RunningSession[]
  /**
   * 会话 id → 它**还没处理**的条目标题（空数组＝没人等）。
   *
   * 这不是「在跑」，而是「在等你」——两者在页面上必须分开：一条会话在跑但等你确认，与
   * 它自己空转，需要的动作完全不同。数据来自工作台已有的条目，不依赖宿主暴露会话状态。
   */
  readonly waitingOn: (sessionId: string) => readonly string[]
  /** 看板的面；有它才谈得上「做完等你确认」。 */
  readonly workbench?: WorkbenchFace
  /** Open one session in the conversation page; absent means no button. */
  readonly openSession?: (sessionId: string) => OpenOutcome
  /** Whether that action can reach a real service right now. */
  readonly canOpenSession?: () => boolean
}): ReactNode {
  const { t } = props
  const sessions = props.running()
  const [failure, setFailure] = useState('')
  const canOpen = props.openSession !== undefined && props.canOpenSession?.() === true
  /**
   * Open one session. A failure is said next to the list rather than swallowed:
   * a click that does nothing reads as a broken page.
   * @param sessionId - the session to open.
   */
  const open = (sessionId: string): void => {
    const outcome = props.openSession?.(sessionId)
    if (outcome === undefined) return
    setFailure(outcome.ok ? '' : t('focusOpenFailed', { message: outcome.message ?? '' }))
  }
  return (
    <section className={CLS.focus}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{t('focusTitle')}</h2>
        <p className={CLS.viewHint}>{t('focusHint')}</p>
      </header>
      {failure === '' ? null : <p className={CLS.openError} role="status">{failure}</p>}
      <h3 className={CLS.viewSubheading}>
        {t('focusCurrent', { count: sessions.length })}
      </h3>
      {sessions.length === 0
        ? <p className={CLS.empty}>{t('focusEmpty')}</p>
        : (
          <ul className={CLS.focusList}>
            {sessions.map((session) => {
              const waiting = props.waitingOn(session.sessionId)
              return (
                <li key={session.sessionId} className={CLS.focusItem}>
                  <div className={CLS.focusMain}>
                    <span className={CLS.focusTitle}>{sessionLabel(session, t)}</span>
                    {session.cwd !== undefined && (
                      <span className={CLS.focusMeta}>{t('focusCwd')}：{session.cwd}</span>
                    )}
                    {/* 等的是什么：只说「待处理」等于让人再点两下去找。 */}
                    {waiting.map((title, index) => (
                      <span key={`${title}-${String(index)}`} className={CLS.focusMeta}>
                        {t('focusWaitingFor')}：{title}
                      </span>
                    ))}
                  </div>
                  <span className={CLS.focusState}>
                    {waiting.length > 0 ? (
                      <>
                        <StateDot state="ongoing" />
                        <Tag tone="quiet">{t('focusWaiting')}</Tag>
                      </>
                    ) : (
                      <>
                        <StateDot state="ongoing" />
                        <Tag tone="info">{t('statusRunning')}</Tag>
                      </>
                    )}
                    {canOpen && (
                      <Button size="sm" onClick={() => { open(session.sessionId) }}>{t('focusOpen')}</Button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      {props.workbench === undefined ? null : (
        <AwaitingList
          face={props.workbench}
          t={t}
          {...(props.openSession === undefined ? {} : { openSession: props.openSession })}
          canOpen={canOpen}
        />
      )}
    </section>
  )
}
/**
 * The third state tier: work finished and waiting for a human.
 *
 * It comes from the board, not from the harness: `awaitingConfirmation` already means
 * "the run is over and its result has not been looked at yet". Reading it here keeps the
 * promise that none of these tiers is invented state.
 *
 * The hook lives in this component so it only runs when a board exists — a conditional
 * hook inside the page would break the rules of hooks.
 * @param props.face - the board.
 * @param props.t - the translate seat.
 * @returns the section, or a line saying there is nothing waiting.
 */
function AwaitingList(props: {
  readonly face: WorkbenchFace
  readonly t: Translate
  readonly openSession?: (sessionId: string) => OpenOutcome
  readonly canOpen: boolean
}): ReactNode {
  // 看板快照在首帧是 undefined（数据还在路上），那时没有「待回写」可言。
  const awaiting: readonly WorkbenchCard[] =
    props.face.useBoard(state => state?.cards.filter(card => card.awaitingConfirmation)) ?? []
  return (
    <>
      <h3 className={CLS.viewSubheading}>
        {props.t('focusAwaiting', { count: awaiting.length })}
      </h3>
      {awaiting.length === 0
        ? <p className={CLS.empty}>{props.t('focusAwaitingEmpty')}</p>
        : (
          <ul className={CLS.focusList}>
            {awaiting.map(card => (
              <li key={card.id} className={CLS.focusItem}>
                <div className={CLS.focusMain}>
                  <span className={CLS.focusTitle}>{card.title}</span>
                </div>
                <span className={CLS.focusState}>
                  <StateDot state="done" />
                  <Tag tone="quiet">{props.t('focusAwaitingTag')}</Tag>
                  {props.canOpen && props.openSession !== undefined && card.sessionId !== undefined && (
                    <Button size="sm" onClick={() => { props.openSession?.(card.sessionId as string) }}>
                      {props.t('focusOpen')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
    </>
  )
}