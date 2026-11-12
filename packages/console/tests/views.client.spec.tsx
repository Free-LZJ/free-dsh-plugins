// @vitest-environment jsdom
/**
 * The connectors view.
 *
 * 它要说清两件事：哪些连接器在喂规则、每个连接器带来什么；以及**开关在这里**——
 * 关掉一个连接器只是让它不再派活，不是卸载它的插件。
 *
 * @module @free-dsh-plugins/dsh-console/tests/views-client
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    tasks: [],
    cards: [],
    sessions: [],
    connectors: [{
      id: 'mail',
      label: '邮件',
      directions: ['in'],
      enabled: true,
      implemented: true,
      triggers: ['mail:new'],
      actions: ['markRead'],
    }],
    revision: 3,
  }
}

/** The face over one fixed state. */
function face(state: WorkbenchState): WorkbenchFace {
  return {
    useBoard: <S,>(select: (current: WorkbenchState | undefined) => S) => select(state),
    useNotices: <S,>(select: (current: readonly never[]) => S) => select([]),
    dispatch: async () => true,
    move: async () => true,
    interrupt: async () => true,
    pause: async () => true,
    resume: async () => true,
    end: async () => true,
    confirm: async () => true,
    detach: async () => true,
  }
}

describe('ConnectorsView', () => {
  it('lists a connector with what it brings to the rules', () => {
    render(<ConnectorsView t={t} face={face(board())} />)
    expect(screen.getByText('邮件')).toBeTruthy()
    expect(screen.getByText('mail:new')).toBeTruthy()
    expect(screen.getByText('markRead')).toBeTruthy()
  })

  it('每个连接器一个开关，点下去就写回引擎', async () => {
    const written: { id: string; enabled: boolean }[] = []
    const withSwitch = face(board())
    const props = { ...withSwitch, setConnector: async (id: string, enabled: boolean) => { written.push({ id, enabled }); return { ok: true } } }
    render(<ConnectorsView t={t} face={{ ...props, setConnector: props.setConnector }} />)
    const toggle = screen.getByRole('switch', { name: '邮件' })
    fireEvent.click(toggle)
    await waitFor(() => { expect(written).toEqual([{ id: 'mail', enabled: false }]) })
  })

  it('没有引擎可写时开关是锁住的', () => {
    render(<ConnectorsView t={t} face={face(board())} />)
    expect((screen.getByRole('switch', { name: '邮件' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('一个连接器都没有时说清是没装，而不是画一个空列表', () => {
    render(<ConnectorsView t={t} face={face({ ...board(), connectors: [] })} />)
    expect(screen.getByText(t('connectorsEmpty'))).toBeTruthy()
  })
})

