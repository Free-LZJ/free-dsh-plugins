// @vitest-environment jsdom
/** The agent-import settings page as the settings shell renders it. */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from './support/runtime.ts'
import { skillCandidate, skillCatalog, skillOutcome, skillReport } from './support/skills.ts'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentImportCard, type AgentImportCardProps } from '../src/client/AgentImportCard.tsx'
import type {
  AgentImportPageState, AgentImportReportState, AgentImportSkillActionState, AgentImportSkillContentState,
  AgentImportSkillSourceState, AgentImportSkillsState, AgentImportSourceState,
} from '../src/client/agent-import-card-controller.ts'
import { SKILL_IMPORT_SOURCES } from '../src/client/agent-import-fields.ts'
import type { AgentImportReport } from '../src/client/agent-import-report.ts'
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

/** The skill-source selection, with the named tools checked. */
function skillChoices(...checked: readonly string[]): readonly AgentImportSkillSourceState[] {
  return SKILL_IMPORT_SOURCES.map(option => ({ value: option.id, checked: checked.includes(option.id) }))
}

/** The switches no test overrides, at their blank-page states. */
function switches(overrides: Partial<AgentImportPageState['switches']> = {}): AgentImportPageState['switches'] {
  return {
    mcp: { checked: false, overridden: false },
    skills: { checked: false, overridden: false },
    skillAutoImport: { checked: false, overridden: false },
    'codex.includeSystemSkills': { checked: false, overridden: false },
    failOnStartupError: { checked: false, overridden: false },
    ...overrides,
  }
}

/** Every control at its default, as a row that has never been configured renders. */
function blankPage(): Omit<AgentImportPageState, keyof SettingsFormShell> {
  return {
    sources: { choices: choices(), overridden: false },
    skillSources: { choices: skillChoices(), overridden: false },
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
    switches: switches(),
  }
}

/** The row's page state as a real deployment serves it. */
const servedPage: Omit<AgentImportPageState, keyof SettingsFormShell> = {
  sources: { choices: choices('codex', 'claude-code'), overridden: false },
  skillSources: { choices: skillChoices('codex', 'claude-code'), overridden: false },
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
  switches: switches({
    mcp: { checked: true, overridden: false },
    skills: { checked: true, overridden: false },
    skillAutoImport: { checked: true, overridden: false },
  }),
}

/** The face a registry injects, with every action recorded. */
function cardActions() {
  return {
    edit: vi.fn(), clear: vi.fn(), setToggle: vi.fn(), setChoices: vi.fn(), setList: vi.fn(), save: vi.fn(), discard: vi.fn(),
    refreshReport: vi.fn(), refreshSkills: vi.fn(), importSkill: vi.fn(), removeSkill: vi.fn(), openSkill: vi.fn(), closeSkill: vi.fn(),
  }
}

/** One import result, as the Host half reports it. */
function report(overrides: Partial<AgentImportReport> = {}): AgentImportReport {
  return { importedAt: '2026-09-30T00:00:00.000Z', sources: ['codex'], skills: [], servers: [], notes: [], ...overrides }
}

/** The loaded-items snapshot the card's second hook serves. */
function reportHook(state: AgentImportReportState) {
  return bindSnapshotSelector(createSnapshotStore<AgentImportReportState>(state))
}

/** The switch the page renders for one configuration field. */
function toggle(name: string) {
  return screen.getByRole('switch', { name })
}

/** The MCP source rows, which the page groups apart from the skill source rows. */
function mcpSources() {
  return within(screen.getByRole('group', { name: en.sources }))
}

/** The skill source rows, which name many of the same tools. */
function skillSources() {
  return within(screen.getByRole('group', { name: en.skillSources }))
}

/** One MCP source row's switch, by the name the page gives what it reads. */
function mcpSwitch(label: string) {
  return mcpSources().getByRole('switch', { name: t('sourceSwitch', { source: label }) })
}

/** One skill source row's switch, by the name the page gives what it links. */
function skillSourceSwitch(label: string) {
  return skillSources().getByRole('switch', { name: t('skillSourceSwitch', { source: label }) })
}

/** One skill row's switch, by the name the page gives what it loads. */
function skillSwitch(name: string) {
  return screen.getByRole('switch', { name: t('skillSwitch', { name }) })
}

/**
 * Open the fields one source row reveals.
 *
 * The row is the shell's disclosure chrome: its own control is the leading
 * chevron, which carries `aria-expanded` and nothing else this page names.
 */
function expandRow(control: HTMLElement): void {
  const row = control.closest('[data-disclosure-row]')
  fireEvent.click(within(row as HTMLElement).getByRole('button', { expanded: false }))
}

/** Whether one source row offers a disclosure at all. */
function expandable(control: HTMLElement): boolean {
  const row = control.closest('[data-disclosure-row]')
  return row !== null && within(row as HTMLElement).queryByRole('button', { expanded: false }) !== null
}

/** One snapshot selector bound to a store that never changes under the test. */
function held<State>(state: State) {
  return bindSnapshotSelector(createSnapshotStore<State>(state))
}

/** Switch the card to its configuration tab, where the settings form lives. */
function openConfig(): void {
  fireEvent.click(screen.getByRole('tab', { name: en.configTitle }))
}

/** Switch the card to its Skills tab. */
function openSkills(): void {
  fireEvent.click(screen.getByRole('tab', { name: en.skillsTitle }))
}

/** Render the card from one page state, one report state, and one Skills state. */
function renderCard(
  state: Partial<AgentImportPageState> = {},
  loaded: AgentImportReportState = { phase: 'unavailable', reason: 'not read' },
  tab: 'loaded' | 'skills' | 'config' = 'config',
  skills: AgentImportSkillsState = { phase: 'idle' },
  action: AgentImportSkillActionState = { phase: 'idle' },
  content: AgentImportSkillContentState = { phase: 'closed' },
) {
  const page = { ...settled, ...servedPage, ...state }
  const store = createSnapshotStore<AgentImportPageState>(page)
  const actions = cardActions()
  const props = {
    ...actions,
    close: () => {},
    t,
    useAgentImportCard: bindSnapshotSelector(store),
    useAgentImportReport: reportHook(loaded),
    useAgentImportSkills: held(skills),
    useAgentImportSkillAction: held(action),
    useAgentImportSkillContent: held(content),
  } as AgentImportCardProps
  render(<AgentImportCard {...props} />)
  // A page the Host does not serve renders its own notice in place of the card.
  if (tab === 'config' && page.available) openConfig()
  if (tab === 'skills') openSkills()
  return actions
}

/** Render the card on its Skills tab, with the catalog and outcome a test stages. */
function renderSkills(
  skills: AgentImportSkillsState,
  staged: {
    action?: AgentImportSkillActionState
    content?: AgentImportSkillContentState
    state?: Partial<AgentImportPageState>
  } = {},
) {
  return renderCard(
    staged.state ?? {},
    { phase: 'unavailable', reason: 'not read' },
    'skills',
    skills,
    staged.action ?? { phase: 'idle' },
    staged.content ?? { phase: 'closed' },
  )
}

describe('AgentImportCard', () => {
  it('renders every field the Host serves, with its resolved value', () => {
    renderCard()

    expect(screen.getByLabelText(en.projectRoot)).toHaveProperty('value', '')
    expect(screen.getByLabelText(en.maxServers)).toHaveProperty('value', '64')
    expect(screen.getByLabelText(en.maxSkills)).toHaveProperty('value', '200')
    expect(toggle(en.mcp).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Server name 1')).toHaveProperty('value', '')
    // A tool's own directories live in its source row, so they are rendered once
    // that row is open rather than beside the workspace root.
    expect(screen.queryByLabelText(en.codexHome)).toBeNull()
    expandRow(mcpSwitch(en.sourceCodex))
    expect(screen.getByLabelText(en.codexHome)).toHaveProperty('value', '/home/u/.codex')
    expect(screen.getByLabelText(en.codexConfigPath)).toHaveProperty('value', '/home/u/.codex/config.toml')
    expandRow(mcpSwitch(en.sourceClaudeCode))
    expect(screen.getByLabelText(en.claudeCodeConfigDir)).toHaveProperty('value', '/home/u/.claude')
    expect(screen.getByLabelText(en.claudeCodeConfigPath)).toHaveProperty('value', '/home/u/.claude.json')
    // Codex's own system skills are a property of reading Codex skills, so they
    // live in the Codex row of the skill sources rather than in the import scope.
    expect(screen.queryByRole('switch', { name: en.codexIncludeSystemSkills })).toBeNull()
    expandRow(skillSourceSwitch(en.skillSourceCodex))
    expect(toggle(en.codexIncludeSystemSkills).getAttribute('aria-checked')).toBe('false')
  })

  it('groups the controls under titled sections', () => {
    renderCard()

    const headings = screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)
    expect(headings).toEqual([en.sources, en.pathsTitle, en.scopeTitle, en.serverDenyList])
  })

  it('gives every source one row, switched on and expandable, and the automatic import switch', () => {
    const actions = renderCard()

    expect(screen.getByRole('heading', { level: 4, name: en.skillSources })).toBeTruthy()
    expect(screen.getByText(en.skillSourcesHint)).toBeTruthy()
    // A source the row reads is switched on; one it does not is left off. dsh's own
    // root is read whether or not it is named, so its row is offered but off.
    expect(mcpSwitch(en.sourceCodex).getAttribute('aria-checked')).toBe('true')
    expect(mcpSwitch(en.sourceClaudeCode).getAttribute('aria-checked')).toBe('true')
    expect(skillSourceSwitch(en.skillSourceCodex).getAttribute('aria-checked')).toBe('true')
    expect(skillSourceSwitch(en.skillSourceDsh).getAttribute('aria-checked')).toBe('false')
    expect(skillSourceSwitch(en.skillSourceCursor).getAttribute('aria-checked')).toBe('false')
    expect(toggle(en.skillAutoImport).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(skillSourceSwitch(en.skillSourceCursor))
    expect(actions.setChoices).toHaveBeenCalledWith('skillSources', ['codex', 'claude-code', 'cursor'])

    fireEvent.click(mcpSwitch(en.sourceCodex))
    expect(actions.setChoices).toHaveBeenCalledWith('sources', ['claude-code'])

    fireEvent.click(toggle(en.skillAutoImport))
    expect(actions.setToggle).toHaveBeenCalledWith('skillAutoImport', false)
  })

  it('opens on the loaded tab, and leaves the settings form off it', () => {
    renderCard({}, { phase: 'loading' }, 'loaded')

    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent)
    expect(tabs).toEqual([en.loadedTitle, en.skillsTitle, en.configTitle])
    expect(screen.getByRole('tab', { name: en.loadedTitle }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByLabelText(en.projectRoot)).toBeNull()

    openConfig()
    expect(screen.getByLabelText(en.projectRoot)).toHaveProperty('value', '')
    expandRow(mcpSwitch(en.sourceCodex))
    expect(screen.getByLabelText(en.codexHome)).toHaveProperty('value', '/home/u/.codex')
  })

  it('tabulates the skills and servers the import reports, with a count above each table', () => {
    renderCard({}, {
      phase: 'ready',
      report: report({
        skills: [{ name: 'drawio-generator', description: 'Draws.', source: 'codex', path: '/home/u/.codex/skills/drawio/SKILL.md' }],
        servers: [
          { name: 'demo', serverName: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'mounted' },
          { name: 'fs', transport: 'stdio', target: 'fs-server', source: 'codex', status: 'skipped', reason: 'listed in serverDenyList' },
        ],
        notes: ['codex: server "fs" skipped: listed in serverDenyList'],
      }),
    }, 'loaded')

    expect(screen.getByText('1 skills · 2 MCP servers')).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      en.columnName, en.columnSource, en.columnPath, en.columnName, en.columnStatus, en.columnTarget, en.columnReason,
    ])
    expect(screen.getByText('drawio-generator')).toBeTruthy()
    expect(screen.getByTitle('/home/u/.codex/skills/drawio/SKILL.md')).toBeTruthy()
    expect(screen.getByText(en.loadedMounted)).toBeTruthy()
    expect(screen.getByText(en.loadedSkipped)).toBeTruthy()
    expect(screen.getByText('fs-server')).toBeTruthy()
    expect(screen.getByText('listed in serverDenyList')).toBeTruthy()
    expect(screen.getByText('codex: server "fs" skipped: listed in serverDenyList')).toBeTruthy()
  })

  it('leaves out a detail column no server fills', () => {
    renderCard({}, {
      phase: 'ready',
      report: report({
        servers: [{ name: 'demo', serverName: 'demo', transport: 'stdio', target: 'demo-server', source: 'codex', status: 'mounted' }],
      }),
    }, 'loaded')

    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      en.columnName, en.columnStatus, en.columnTarget,
    ])
  })

  it('says an empty import loaded nothing', () => {
    renderCard({}, { phase: 'ready', report: report() }, 'loaded')

    expect(screen.getByText('0 skills · 0 MCP servers')).toBeTruthy()
    expect(screen.getByText(en.loadedNoSkills)).toBeTruthy()
    expect(screen.getByText(en.loadedNoServers)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says it is still reading the import result, and why when the read failed', () => {
    renderCard({}, { phase: 'loading' }, 'loaded')
    expect(screen.getByText(en.reportLoading)).toBeTruthy()

    cleanup()
    const actions = renderCard({}, { phase: 'unavailable', reason: 'HTTP 404' }, 'loaded')
    expect(screen.getByText('The import result is unavailable: HTTP 404')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(actions.refreshReport).toHaveBeenCalledTimes(1)
  })

  it('stages the text and number drafts a user types', () => {
    const actions = renderCard()

    expandRow(mcpSwitch(en.sourceCodex))
    fireEvent.change(screen.getByLabelText(en.codexHome), { target: { value: 'D:/codex' } })
    fireEvent.change(screen.getByLabelText(en.maxSkills), { target: { value: '150' } })

    expect(actions.edit.mock.calls).toEqual([['codex.home', 'D:/codex'], ['maxSkills', '150']])
  })

  it('stages a switch, a source selection, and the denied server rows', () => {
    const actions = renderCard()

    fireEvent.click(toggle(en.failOnStartupError))
    fireEvent.click(mcpSwitch(en.sourceClaudeCode))
    fireEvent.change(screen.getByLabelText('Server name 1'), { target: { value: 'fs' } })
    fireEvent.click(screen.getByRole('button', { name: en.addDenyEntry }))

    expect(actions.setToggle.mock.calls).toEqual([['failOnStartupError', true]])
    expect(actions.setChoices.mock.calls).toEqual([['sources', ['codex']]])
    expect(actions.setList.mock.calls).toEqual([
      ['serverDenyList', ['fs']],
      ['serverDenyList', ['', '']],
    ])
  })

  it('stages a source switched back on in import precedence order', () => {
    const actions = renderCard({ sources: { choices: choices('claude-code'), overridden: true } })

    fireEvent.click(mcpSwitch(en.sourceCodex))

    expect(actions.setChoices.mock.calls).toEqual([['sources', ['codex', 'claude-code']]])
  })

  it('renders a source row as a plain row when it reveals nothing', () => {
    renderCard()

    // Cursor is a switch and nothing else, so its row offers no disclosure; the
    // tools with directories of their own do.
    expect(expandable(skillSourceSwitch(en.skillSourceCursor))).toBe(false)
    expect(expandable(mcpSwitch(en.sourceCodex))).toBe(true)
  })

  it('reveals a tool\u2019s directories while either half of that tool is in use', () => {
    // Codex reads no MCP servers, but its skills are auto-imported, and those same
    // directories decide where its skills come from: the paths stay reachable.
    renderCard({
      sources: { choices: choices('claude-code'), overridden: true },
      skillSources: { choices: skillChoices('codex'), overridden: true },
    })

    expect(mcpSwitch(en.sourceCodex).getAttribute('aria-checked')).toBe('false')
    expandRow(mcpSwitch(en.sourceCodex))
    expect(screen.getByLabelText(en.codexHome)).toHaveProperty('value', '/home/u/.codex')
  })

  it('leaves a tool no half of the import uses with no row to open', () => {
    renderCard({
      sources: { choices: choices(), overridden: true },
      skillSources: { choices: skillChoices(), overridden: true },
    })

    expect(expandable(mcpSwitch(en.sourceCodex))).toBe(false)
    expect(screen.queryByLabelText(en.codexHome)).toBeNull()
  })

  it('shows the Codex system-skills switch only once Codex skills are auto-imported', () => {
    renderCard({ skillSources: { choices: skillChoices('claude-code'), overridden: true } })

    expect(expandable(skillSourceSwitch(en.skillSourceCodex))).toBe(false)
    expect(screen.queryByRole('switch', { name: en.codexIncludeSystemSkills })).toBeNull()
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
      skillSources: { choices: skillChoices('codex'), overridden: true },
      serverDenyList: { rows: ['fs'], overridden: true },
      values: { ...servedPage.values, 'codex.home': field('/custom/.codex', { overridden: true }) },
      switches: { ...servedPage.switches, mcp: { checked: true, overridden: true } },
    })
    // A field's own reset is inside the row that holds it, so the row is opened
    // the way a user would open it before the control exists at all.
    expandRow(mcpSwitch(en.sourceCodex))

    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(5)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.clear.mock.calls).toEqual([['codex.home'], ['sources'], ['skillSources'], ['mcp'], ['serverDenyList']])
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
    expect(screen.getByLabelText(en.projectRoot)).toHaveProperty('disabled', true)
    expect(toggle(en.mcp)).toHaveProperty('disabled', true)
    expect(mcpSwitch(en.sourceCodex)).toHaveProperty('disabled', true)
    expect(skillSourceSwitch(en.skillSourceCodex)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Server name 1')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.addDenyEntry })).toHaveProperty('disabled', true)
  })

  it('says so in place of the controls while the Host does not serve the namespace', () => {
    renderCard({ available: false, ...blankPage() })

    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(screen.queryByLabelText(en.projectRoot)).toBeNull()
  })

  it('disables every control and reports the save in flight while one crosses the wire', () => {
    renderCard({ saving: true, dirty: true })

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.maxServers)).toHaveProperty('disabled', true)
    expect(toggle(en.skills)).toHaveProperty('disabled', true)
    expect(mcpSwitch(en.sourceCodex)).toHaveProperty('disabled', true)
  })

  it('drops every staged edit when the page leaves it', () => {
    const actions = renderCard({ dirty: true })

    cleanup()

    expect(actions.discard).toHaveBeenCalledTimes(1)
  })
})

describe('AgentImportCard, on the Skills tab', () => {
  it('offers the Skills tab, and reads the catalog only once it is opened', () => {
    const actions = renderCard({}, { phase: 'unavailable', reason: 'not read' }, 'loaded')

    // Building the catalog scans every agent's skill directories.
    expect(actions.refreshSkills).not.toHaveBeenCalled()

    openSkills()

    expect(actions.refreshSkills).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.skillsLoading)).toBeTruthy()
  })

  it('lists each skill with its state, its source, and one switch that loads it', () => {
    renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [
          skillReport({ name: 'drawio-generator', description: 'Draws diagrams.' }),
          skillReport({
            name: 'linked-one',
            state: 'linked',
            installedPath: '/home/u/.dsh/skills/linked-one',
            installedSource: 'cursor',
            candidates: [skillCandidate({ source: 'cursor', label: 'Cursor' })],
          }),
        ],
      }),
    })

    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(screen.getByText('2 skills · 1 on · 0 disabled')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('drawio-generator')).toBeTruthy()
    expect(screen.getByText('Draws diagrams.')).toBeTruthy()
    expect(screen.getByText(en.skillStateAvailable)).toBeTruthy()
    expect(screen.getByText(en.skillStateLinked)).toBeTruthy()
    expect(screen.getByText('Imported from Cursor')).toBeTruthy()
    expect(screen.getByTitle('/home/u/.dsh/skills/linked-one')).toBeTruthy()
    // The switch states what dsh loads, which is the whole action a row offers.
    expect(skillSwitch('drawio-generator').getAttribute('aria-checked')).toBe('false')
    expect(skillSwitch('linked-one').getAttribute('aria-checked')).toBe('true')
  })

  it('switches a name that is not imported on, and one that is imported off', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({ skills: [skillReport(), skillReport({ name: 'linked-one', state: 'linked' })] }),
    })

    fireEvent.click(skillSwitch('demo'))
    expect(actions.importSkill).toHaveBeenCalledWith({ name: 'demo' })

    fireEvent.click(skillSwitch('linked-one'))
    expect(actions.removeSkill).toHaveBeenCalledWith('linked-one')
  })

  it('counts the names dsh loads, and the names the user switched off', () => {
    renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [
          skillReport({ name: 'available-one' }),
          skillReport({ name: 'off-one', state: 'disabled' }),
          skillReport({ name: 'linked-one', state: 'linked' }),
          skillReport({ name: 'local-one', state: 'local' }),
          skillReport({ name: 'broken-one', state: 'broken' }),
        ],
      }),
    })

    expect(screen.getByText('5 skills · 3 on · 1 disabled')).toBeTruthy()
  })

  it('states why a name the user switched off is not loaded, and imports it again', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({ skills: [skillReport({ name: 'off-one', state: 'disabled' })] }),
    })

    expect(screen.getByText(en.skillStateDisabled)).toBeTruthy()
    expect(screen.getByText(en.skillDisabled)).toBeTruthy()
    // Nothing is installed, but the row is not the untouched one either.
    expect(screen.queryByText(en.skillManual)).toBeNull()
    expect(skillSwitch('off-one').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(skillSwitch('off-one'))
    expect(actions.importSkill).toHaveBeenCalledWith({ name: 'off-one' })
  })

  it('refuses a second press while one write is still in flight', () => {
    renderSkills(
      { phase: 'ready', catalog: skillCatalog({ skills: [skillReport({ name: 'demo' })] }) },
      { action: { phase: 'busy', name: 'demo' } },
    )

    // The first press already asked for the opposite of what a second one would.
    expect(skillSwitch('demo')).toHaveProperty('disabled', true)
  })

  it('offers a switched-off name its sources without a replacement', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [skillReport({
          name: 'off-one',
          state: 'disabled',
          conflict: true,
          candidates: [
            skillCandidate({ source: 'codex', label: 'Codex', winner: true }),
            skillCandidate({ source: 'cursor', label: 'Cursor', winner: false }),
          ],
        })],
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Import from Cursor' }))

    // Nothing is linked yet, so there is no link to replace.
    expect(actions.importSkill).toHaveBeenCalledWith({ name: 'off-one', source: 'cursor' })
  })

  it('flags a skill whose every offering sits outside the automatic set', () => {
    renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [
          skillReport({ name: 'auto-one' }),
          skillReport({
            name: 'manual-one',
            candidates: [skillCandidate({ source: 'cursor', label: 'Cursor', winner: true })],
          }),
        ],
      }),
    })

    // The row auto-imports Codex and Claude Code, so only the second name is manual.
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).queryByText(en.skillManual)).toBeNull()
    expect(within(rows[1]!).getByText(en.skillManual)).toBeTruthy()
  })

  it('names the other sources of a conflict, and switches the link to one of them', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [skillReport({
          name: 'demo',
          state: 'linked',
          installedPath: '/home/u/.dsh/skills/demo',
          installedSource: 'codex',
          conflict: true,
          candidates: [
            skillCandidate({ source: 'codex', label: 'Codex', winner: true }),
            skillCandidate({ source: 'cursor', label: 'Cursor', winner: false, path: '/home/u/.cursor/skills/demo' }),
          ],
        })],
      }),
    })

    expect(screen.getByText(en.skillConflict)).toBeTruthy()
    expect(screen.getByText('Also offered by Cursor.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Import from Cursor' }))

    // Changing where a link points has to replace the link that is already there.
    expect(actions.importSkill).toHaveBeenCalledWith({ name: 'demo', source: 'cursor', replace: true })
  })

  it('offers each source for a name nothing has linked yet, without a replacement', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [skillReport({
          name: 'demo',
          conflict: true,
          candidates: [
            skillCandidate({ source: 'codex', label: 'Codex', winner: true }),
            skillCandidate({ source: 'cursor', label: 'Cursor', winner: false }),
          ],
        })],
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Import from Cursor' }))

    expect(actions.importSkill).toHaveBeenCalledWith({ name: 'demo', source: 'cursor' })
  })

  it('explains a name a real local directory owns, and refuses to switch it off', () => {
    renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [skillReport({ name: 'handwritten', state: 'local', installedPath: '/home/u/.dsh/skills/handwritten' })],
      }),
    })

    expect(screen.getByText(en.skillStateLocal)).toBeTruthy()
    expect(screen.getByText(en.skillLocal)).toBeTruthy()
    // The switch states that dsh loads the name, and says why it cannot be turned
    // off; nothing on the row can remove or replace a real local directory.
    expect(skillSwitch('handwritten').getAttribute('aria-checked')).toBe('true')
    expect(skillSwitch('handwritten')).toHaveProperty('disabled', true)
    expect(skillSwitch('handwritten').getAttribute('title')).toBe(en.skillLocal)
  })

  it('asks for the copy a row points at when its instructions are opened', () => {
    const actions = renderSkills({ phase: 'ready', catalog: skillCatalog() })

    fireEvent.click(screen.getByRole('button', { name: en.skillView }))

    expect(actions.openSkill).toHaveBeenCalledWith({ name: 'demo' })
  })

  it('renders the instruction body it was handed, with the file it came from', () => {
    const actions = renderSkills(
      { phase: 'ready', catalog: skillCatalog() },
      {
        content: {
          phase: 'ready',
          content: {
            name: 'demo',
            description: 'Demo skill.',
            source: 'codex',
            file: '/home/u/.codex/skills/demo/SKILL.md',
            content: '# Demo\n\nBody.\n',
          },
        },
      },
    )

    // The body is rendered verbatim, so its own line breaks survive.
    const body = screen.getByText((_, element) => element?.tagName === 'PRE')
    expect(body.textContent).toBe('# Demo\n\nBody.\n')
    expect(screen.getByTitle('/home/u/.codex/skills/demo/SKILL.md')).toBeTruthy()
    expect(screen.getByText(en.skillSourceCodex)).toBeTruthy()
    // The body stands in place of the list, so no row switch is on screen.
    expect(screen.queryByRole('switch')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.skillBack }))
    expect(actions.closeSkill).toHaveBeenCalledTimes(1)
  })

  it('reports what a mutation changed and what it left alone, with the Host\u2019s notes', () => {
    renderSkills(
      { phase: 'ready', catalog: skillCatalog() },
      {
        action: {
          phase: 'done',
          outcome: skillOutcome({
            imported: ['demo'],
            skipped: [{ name: 'other', reason: 'local-copy', detail: '/home/u/.dsh/skills/other' }],
            notes: ['linked into ~/.dsh/skills'],
          }),
        },
      },
    )

    expect(screen.getByText('Imported: demo')).toBeTruthy()
    expect(screen.getByText(en.skillActionSkipped)).toBeTruthy()
    expect(screen.getByText('other')).toBeTruthy()
    expect(screen.getByText(en.skipLocalCopy)).toBeTruthy()
    expect(screen.getByText('/home/u/.dsh/skills/other')).toBeTruthy()
    expect(screen.getByText(en.skillActionNotes)).toBeTruthy()
    expect(screen.getByText('linked into ~/.dsh/skills')).toBeTruthy()
  })

  it('shows why the catalog could not be read, and whether the Host was reached', () => {
    renderSkills({ phase: 'unavailable', reason: 'the scan threw' })

    expect(screen.getByText('The skill catalog is unavailable: the scan threw')).toBeTruthy()

    cleanup()
    renderSkills({ phase: 'unavailable', reason: 'TypeError: Failed to fetch', offline: true })

    expect(screen.getByText(en.skillsOffline)).toBeTruthy()
  })

  it('shows why a mutation failed, and names the Host when it was never reached', () => {
    renderSkills(
      { phase: 'ready', catalog: skillCatalog() },
      { action: { phase: 'failed', reason: 'that path is not a link' } },
    )

    expect(screen.getByText('The action failed: that path is not a link')).toBeTruthy()

    cleanup()
    renderSkills(
      { phase: 'ready', catalog: skillCatalog() },
      { action: { phase: 'failed', reason: 'TypeError: Failed to fetch', offline: true } },
    )

    expect(screen.getByText(en.skillActionOffline)).toBeTruthy()
  })

  it('searches by name, by description, and by source', () => {
    renderSkills({
      phase: 'ready',
      catalog: skillCatalog({
        skills: [
          skillReport({ name: 'drawio-generator', description: 'Draws diagrams.' }),
          skillReport({
            name: 'zebra',
            description: 'Something else.',
            candidates: [skillCandidate({ source: 'cursor', label: 'Cursor' })],
          }),
        ],
      }),
    })

    fireEvent.change(screen.getByLabelText(en.skillSearch), { target: { value: 'cursor' } })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(screen.queryByText('drawio-generator')).toBeNull()
    expect(screen.getByText('zebra')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.skillSearch), { target: { value: 'diagrams' } })
    expect(screen.getByText('drawio-generator')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.skillSearch), { target: { value: 'nothing here' } })
    expect(screen.getByText(en.skillsEmpty)).toBeTruthy()
  })

  it('shows the Host\u2019s own note where an empty catalog has nothing to list', () => {
    const actions = renderSkills({
      phase: 'ready',
      catalog: skillCatalog({ skills: [], notes: ['skill management is disabled by the skills setting'] }),
    })

    expect(screen.getByText(en.skillsNotes)).toBeTruthy()
    expect(screen.getByText('skill management is disabled by the skills setting')).toBeTruthy()
    // The note is the explanation, so an empty-list line would only repeat it.
    expect(screen.queryByText(en.skillsEmpty)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.skillRefresh }))
    expect(actions.refreshSkills).toHaveBeenCalledTimes(1)
  })
})
