/**
 * The focus page — the workbench's second main panel.
 *
 * P0 scope: this lists the sessions the platform already knows about (the Host's
 * `sessionController.list()` projection, which reaches the page through the
 * snapshot's `running` list), with a title, a working directory and "running".
 * The three state tiers the design settled on — 等你回答 / 当前 / 已结束未读 —
 * come from `ctx.uiSession.sessionStatus` in P2, and this page says so instead
 * of pretending the data is there.
 *
 * So it is deliberately thin: no session UI on a second screen, no "open
 * session" button that would need `uiWorkspace` injected, no fake statuses.
 *
 * @module @free-lzj/dsh-console/client/focus
 */

import type { ReactNode } from 'react'
import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunningSession } from '../protocol.ts'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

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
   * 会话 id → 它有一条**还没处理**的条目。
   *
   * 这不是「在跑」，而是「在等你」——两者在页面上必须分开：一条会话在跑但等你确认，与
   * 它自己空转，需要的动作完全不同。数据来自工作台已有的条目，不依赖宿主暴露会话状态。
   */
  readonly waitingOn: (sessionId: string) => boolean
}): ReactNode {
  const { t } = props
  const sessions = props.running()
  return (
    <section className={CLS.focus}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{t('focusTitle')}</h2>
        <p className={CLS.viewHint}>{t('focusHint')}</p>
      </header>
      <h3 className={CLS.viewSubheading}>
        {t('focusCurrent', { count: sessions.length })}
      </h3>
      {sessions.length === 0
        ? <p className={CLS.emptyLine}>{t('focusEmpty')}</p>
        : (
          <ul className={CLS.focusList}>
            {sessions.map((session) => (
              <li key={session.sessionId} className={CLS.focusItem}>
                <div className={CLS.focusMain}>
                  <span className={CLS.focusTitle}>
                    {session.title === '' ? session.sessionId : session.title}
                  </span>
                  {session.cwd !== undefined && (
                    <span className={CLS.focusMeta}>{t('focusCwd')}：{session.cwd}</span>
                  )}
                </div>
                <span className={CLS.focusState}>
                  {props.waitingOn(session.sessionId) ? (
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
                </span>
              </li>
            ))}
          </ul>
        )}
      <p className={CLS.viewMeta}>{t('focusLater')}</p>
    </section>
  )
}
