// @vitest-environment jsdom
/** The agent-import settings card as the Plugins page renders it. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from './support/runtime.ts'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentImportCard, type AgentImportCardProps } from '../src/client/AgentImportCard.tsx'
import type { AgentImportPageState, AgentImportSourceState } from '../src/client/agent-import-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const settled: SettingsFormShell = {
  available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
}

/** One control's state, blank unless the test stages a draft into it. */
function field(text = '', rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/** The source selection, with the named tools checked. */
function choices(...checked: readonly string[]): readonly AgentImportSourceState[] {
  return ['codex', 'claude-code'].map(value => ({ value, checked: checked.includes(value) }) as AgentImportSourceState)
}

/** Every control at its default, as a row that has never been configured renders. */
function blankPage(): Omit<AgentImportPageState, keyof SettingsFormShell> {
  return {
    sources: { choices: choices(), overridden: false },
    serverDenyList: { rows: [''], overridden: false },
    values: {
      projectRoot: field(),
      'codex.home': field(),
      'codex.configPath': field(),
      'claudeCode.configDir': field(),
      'claudeCode.configPath': field(),
      maxServers: field(),
      maxSkills: field(),
    },
    switches: {
      mcp: { checked: false, overridden: false },
      skills: { checked: false, overridden: false },
      'codex.includeSystemSkills': { checked: false, overridden: false },
      failOnStartupError: { checked: false, overridden: false },
    },
  }
}

/** The row's page state as a real deployment serves it. */
const servedPage: Omit<AgentImportPageState, keyof SettingsFormShell> = {
  sources: { choices: choices('codex', 'claude-code'), overridden: false },
  serverDenyList: { rows: [''], overridden: false },
  values: {
    projectRoot: field(),
    'codex.home': field('/home/u/.codex'),
    'codex.configPath': field('/home/u/.codex/config.toml'),
    'claudeCode.configDir': field('/home/u/.claude'),
    'claudeCode.configPath': field('/home/u/.claude.json'),
    maxServers: field('64'),
    maxSkills: field('200'),
  },
  switches: {
    mcp: { checked: true, overridden: false },
    skills: { checked: true, overridden: false },
    'codex.includeSystemSkills': { checked: false, overridden: false },
    failOnStartupError: { checked: false, overridden: false },
  },
}

/** The face a registry injects, with every action recorded. */
function cardActions() {
  return {
    edit: vi.fn(), clear: vi.fn(), setToggle: vi.fn(), setChoices: vi.fn(), setList: vi.fn(), save: vi.fn(), discard: vi.fn(),
  }
}

/** The switch the page renders for one field. */
function toggle(name: string) {
  return screen.getByRole('switch', { name })
}

describe('AgentImportCard', () => {
  function renderCard(state: Partial<AgentImportPageState> = {}) {
    const store = createSnapshotStore<AgentImportPageState>({ ...settled, ...servedPage, ...state })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useAgentImportCard: bindSnapshotSelector(store) } as AgentImportCardProps
    render(<AgentImportCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<AgentImportPageState>({ ...settled, ...servedPage })
    const props = {
      ...cardActions(), view: 'summary', t, useAgentImportCard: bindSnapshotSelector(store),
    } as AgentImportCardProps
    render(<AgentImportCard {...props} />)

    expect(document.body.textContent).toBe(en.summary)
    expect(screen.queryByLabelText(en.codexHome)).toBeNull()
  })

  it('renders every field the Host serves, with its resolved value', () => {
    renderCard()

    expect(screen.getByLabelText(en.projectRoot)).toHaveProperty('value', '')
    expect(screen.getByLabelText(en.codexHome)).toHaveProperty('value', '/home/u/.codex')
    expect(screen.getByLabelText(en.claudeCodeConfigPath)).toHaveProperty('value', '/home/u/.claude.json')
    expect(screen.getByLabelText(en.maxServers)).toHaveProperty('value', '64')
    expect(screen.getByLabelText(en.maxSkills)).toHaveProperty('value', '200')
    expect(toggle(en.mcp).getAttribute('aria-checked')).toBe('true')
    expect(toggle(en.codexIncludeSystemSkills).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText(en.sourceCodex)).toHaveProperty('checked', true)
    expect(screen.getByLabelText('Server name 1')).toHaveProperty('value', '')
  })

  it('stages the text and number drafts a user types', () => {
    const actions = renderCard()

    fireEvent.change(screen.getByLabelText(en.codexHome), { target: { value: 'D:/codex' } })
    fireEvent.change(screen.getByLabelText(en.maxSkills), { target: { value: '150' } })

    expect(actions.edit.mock.calls).toEqual([['codex.home', 'D:/codex'], ['maxSkills', '150']])
  })

  it('stages a switch, a source selection, and the denied server rows', () => {
    const actions = renderCard()

    fireEvent.click(toggle(en.failOnStartupError))
    fireEvent.click(screen.getByLabelText(en.sourceClaudeCode))
    fireEvent.change(screen.getByLabelText('Server name 1'), { target: { value: 'fs' } })
    fireEvent.click(screen.getByRole('button', { name: en.addDenyEntry }))

    expect(actions.setToggle.mock.calls).toEqual([['failOnStartupError', true]])
    expect(actions.setChoices.mock.calls).toEqual([['sources', ['codex']]])
    expect(actions.setList.mock.calls).toEqual([
      ['serverDenyList', ['fs']],
      ['serverDenyList', ['', '']],
    ])
  })

  it('stages a source checked back on in import precedence order', () => {
    const actions = renderCard({ sources: { choices: choices('claude-code'), overridden: true } })

    fireEvent.click(screen.getByLabelText(en.sourceCodex))

    expect(actions.setChoices.mock.calls).toEqual([['sources', ['codex', 'claude-code']]])
  })

  it('stages one edited denied server and leaves the other rows alone', () => {
    const actions = renderCard({ serverDenyList: { rows: ['fs', 'telemetry'], overridden: true } })

    fireEvent.change(screen.getByLabelText('Server name 2'), { target: { value: 'fs-extra' } })

    expect(actions.setList.mock.calls).toEqual([['serverDenyList', ['fs', 'fs-extra']]])
  })

  it('removes one denied server by its row', () => {
    const actions = renderCard({ serverDenyList: { rows: ['fs', 'telemetry'], overridden: true } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove server 1' }))

    expect(actions.setList.mock.calls).toEqual([['serverDenyList', ['telemetry']]])
  })

  it('offers a reset for every field the user layer carries, and only those', () => {
    const actions = renderCard({
      sources: { choices: choices('codex', 'claude-code'), overridden: true },
      serverDenyList: { rows: ['fs'], overridden: true },
      values: { ...servedPage.values, 'codex.home': field('/custom/.codex', { overridden: true }) },
      switches: { ...servedPage.switches, mcp: { checked: true, overridden: true } },
    })

    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(4)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.clear.mock.calls).toEqual([['sources'], ['codex.home'], ['mcp'], ['serverDenyList']])
  })

  it('shows an invalid draft in place of the hint and blocks the save', () => {
    const actions = renderCard({ dirty: true, invalid: true, values: { ...servedPage.values, maxServers: field('many', { invalid: true }) } })

    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
    expect(screen.getByLabelText(en.maxServers).getAttribute('aria-invalid')).toBe('true')
    const save = screen.getByRole('button', { name: en.save })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.click(save)

    expect(actions.save).not.toHaveBeenCalled()
  })

  it('says the deployment stores settings read-only, with every control disabled', () => {
    renderCard({ writable: false })

    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByLabelText(en.codexHome)).toHaveProperty('disabled', true)
    expect(toggle(en.mcp)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.sourceCodex)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Server name 1')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.addDenyEntry })).toHaveProperty('disabled', true)
  })

  it('says so in place of the controls while the Host does not serve the namespace', () => {
    renderCard({ available: false, ...blankPage() })

    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(screen.queryByLabelText(en.codexHome)).toBeNull()
  })

  it('disables every control and reports the save in flight while one crosses the wire', () => {
    renderCard({ saving: true, dirty: true })

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.maxServers)).toHaveProperty('disabled', true)
    expect(toggle(en.skills)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.sourceCodex)).toHaveProperty('disabled', true)
  })

  it('drops every staged edit when the page leaves it', () => {
    const actions = renderCard({ dirty: true })

    cleanup()

    expect(actions.discard).toHaveBeenCalledTimes(1)
  })
})
