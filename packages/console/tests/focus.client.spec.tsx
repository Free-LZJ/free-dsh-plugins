// @vitest-environment jsdom
/**
 * The focus page: what it lists in P0, and what it refuses to pretend.
 *
 * The page is deliberately thin — it reads the sessions the Host already knows
 * about and nothing else. The three state tiers (`等你回答 / 当前 / 已结束未读`)
 * need `ctx.uiSession.sessionStatus`, which this phase does not wire, so the
 * page says where they went instead of drawing empty sections that look broken.
 *
 * @module @free-lzj/dsh-console/tests/focus
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunningSession } from '../src/protocol.ts'
import { FocusPage } from '../src/client/focus.tsx'
import { zh, type Translate } from '../src/client/locales.ts'

afterEach(cleanup)

/** Translate through the real dictionary, so a missing key fails here too. */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** One session, as the Host's `sessionController.list()` answers it. */
function session(overrides: Partial<RunningSession> & Pick<RunningSession, 'sessionId'>): RunningSession {
  return { title: '', ...overrides }
}

describe('the focus page', () => {
  it('lists the sessions working right now, with where they run', () => {
    const running = () => [
      session({ sessionId: 's-1', title: '修 FormSubmit 的回归测试', cwd: 'D:\\open\\free-dsh-plugins' }),
      session({ sessionId: 's-2' }),
    ]
    render(<FocusPage t={t} running={running}
      waitingOn={() => false} />)
    expect(screen.getByText(t('focusCurrent', { count: 2 }))).toBeTruthy()
    expect(screen.getByText('修 FormSubmit 的回归测试')).toBeTruthy()
    expect(screen.getByText(`D:\\open\\free-dsh-plugins`, { exact: false })).toBeTruthy()
    // A session with no title still gets identified by its id.
    expect(screen.getByText('s-2')).toBeTruthy()
    // Status is text, not only a dot.
    expect(screen.getAllByText(t('statusRunning')).length).toBe(2)
  })

  it('explains an empty page instead of leaving a blank one', () => {
    render(<FocusPage t={t} running={() => []} waitingOn={() => false} />)
    expect(screen.getByText(t('focusCurrent', { count: 0 }))).toBeTruthy()
    expect(screen.getByText(t('focusEmpty'))).toBeTruthy()
  })

  it('says which parts wait for P2 rather than showing dead controls', () => {
    render(<FocusPage t={t} running={() => []} waitingOn={() => false} />)
    expect(screen.getByText(t('focusHint'))).toBeTruthy()
    expect(screen.getByText(t('focusLater'))).toBeTruthy()
    // 没有假按钮：这一版不给「进入会话」，因为它需要一个还没注入的服务。
    expect(screen.queryAllByRole('button')).toEqual([])
  })


  it('says which running sessions are waiting on you', () => {
    // 「在跑」与「在等你」是两件事：一条会话跑着但等你确认时，该做的动作完全不同。
    render(<FocusPage t={t} running={() => [session({ sessionId: 's1', title: '看板' })]} waitingOn={(id) => id === 's1'} />)
    expect(screen.getByText('等你处置')).toBeTruthy()
  })})
