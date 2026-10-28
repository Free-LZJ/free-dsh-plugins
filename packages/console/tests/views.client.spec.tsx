// @vitest-environment jsdom
/**
 * The connectors view.
 *
 * Two things it must say without lying: which connectors are switched on, and —
 * the newer half — which **executors** this deployment actually has. A routing
 * table naming an executor that is missing is a configuration answer the user can
 * act on; a silently dead button is not.
 *
 * @module @free-dsh-plugins/dsh-console/tests/views-client
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorsView } from '../src/client/views.tsx'
import { zh, type Translate } from '../src/client/locales.ts'
import type { WorkbenchFace } from '../src/client/workbench/board.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

const t: Translate = (key, params) => {
  const template: string = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

afterEach(cleanup)

/** A board state with one connector and one executor. */
function board(): WorkbenchState {
  return {
    cards: [],
    sessions: [],
    executors: [{ id: 'dsh', label: 'DSH（模拟）' }],
    connectors: [{
      id: 'mail',
      label: '邮件',
      directions: ['in'],
      enabled: true,
      implemented: true,
    }],
    routingVersion: 'workbench-routes-v1',
    executorNote: '',
    revision: 3,
  }
}

/** The face over one fixed state. */
function face(state: WorkbenchState): WorkbenchFace {
  return {
    useBoard: <S,>(select: (current: WorkbenchState | undefined) => S) => select(state),
    ingest: async () => ({ ok: true }),
    dispatch: async () => true,
    move: async () => true,
    interrupt: async () => true,
    pause: async () => true,
    resume: async () => true,
    end: async () => true,
    confirm: async () => true,
  }
}

describe('ConnectorsView', () => {
  it('lists the executors this deployment registered', () => {
    render(<ConnectorsView t={t} face={face(board())} />)
    expect(screen.getByText(t('executorsTitle'))).toBeTruthy()
    expect(screen.getByText('DSH（模拟）')).toBeTruthy()
    expect(screen.getByText(t('executorReady'))).toBeTruthy()
  })

  it('says which setting is missing instead of just showing no real executor', () => {
    // 静默缺席会让人以为功能坏了——上一轮我就是这么把 P2 判成「等宿主」的。
    render(<ConnectorsView t={t} face={face({ ...board(), executorNote: 'no-workspace' })} />)
    expect(screen.getByRole('status').textContent).toContain('workbenchWorkspace')
  })

  it('says nothing extra when the real executor is registered', () => {
    render(<ConnectorsView t={t} face={face(board())} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('still says which connectors are on', () => {
    render(<ConnectorsView t={t} face={face(board())} />)
    expect(screen.getByText('邮件')).toBeTruthy()
    expect(screen.getByText(t('connectorEnabled'))).toBeTruthy()
  })
})
