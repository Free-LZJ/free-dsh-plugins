/** The page state the agent-import row projects, and the writes its actions stage. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from './support/runtime.ts'
import { skillCatalog, skillOutcome, skillReport } from './support/skills.ts'
import { AgentImportCardController } from '../src/client/agent-import-card-controller.ts'
import type { AgentImportSkillsPort } from '../src/client/agent-import-card-controller.ts'
import type {
  SkillCatalogResult, SkillContentResult, SkillMutationResult,
} from '../src/client/agent-import-skills.ts'
import { SKILL_IMPORT_SOURCES, type AgentImportSettings } from '../src/client/agent-import-fields.ts'
import type { AgentImportReportResult } from '../src/client/agent-import-report.ts'

/** The section the Host resolves before any user override. */
const DEFAULTS: AgentImportSettings = {
  sources: ['codex', 'claude-code'],
  skillSources: ['codex', 'claude-code'],
  skillAutoImport: true,
  codex: { home: '/home/u/.codex', configPath: '/home/u/.codex/config.toml', includeSystemSkills: false },
  claudeCode: { configDir: '/home/u/.claude', configPath: '/home/u/.claude.json' },
  projectRoot: '',
  mcp: true,
  skills: true,
  serverDenyList: [],
  maxServers: 64,
  maxSkills: 200,
  failOnStartupError: false,
}

/** A served row: revision 7, one overridden bound, and one denied server in the user layer. */
function served() {
  const host = stubConfigForm<AgentImportSettings>()
  host.publish({
    status: 'ready',
    writable: true,
    revision: 7,
    value: { ...DEFAULTS, maxServers: 8, serverDenyList: ['fs'] },
    base: DEFAULTS,
    user: { maxServers: 8, serverDenyList: ['fs'] },
  })
  return host
}

/** A report read the form tests never exercise. */
const unread = (): Promise<AgentImportReportResult> => Promise.resolve({ phase: 'unavailable', reason: 'not read' })

/** The skill routes, with every call recorded and no answer staged yet. */
function skillsPort() {
  return {
    loadCatalog: vi.fn((): Promise<SkillCatalogResult> => Promise.reject(new Error('no catalog staged'))),
    loadContent: vi.fn((): Promise<SkillContentResult> => Promise.reject(new Error('no body staged'))),
    importSkill: vi.fn((): Promise<SkillMutationResult> => Promise.reject(new Error('no import staged'))),
    removeSkill: vi.fn((): Promise<SkillMutationResult> => Promise.reject(new Error('no removal staged'))),
  } satisfies AgentImportSkillsPort
}

describe('AgentImportCardController', () => {
  it('projects every control the page renders from the section the Host serves', () => {
    const host = served()
    const controller = new AgentImportCardController(host.scope, unread)
    const { agentImportCard } = controller.inject().hooks

    // Twenty-two skill sources would bury the rest of the projection, so they are
    // checked against the Host's own list instead of being spelled out here.
    const { skillSources, ...page } = agentImportCard.getSnapshot()
    expect(page).toEqual({
      available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
      sources: {
        choices: [{ value: 'codex', checked: true }, { value: 'claude-code', checked: true }],
        overridden: false,
      },
      serverDenyList: { rows: ['fs'], overridden: true },
      values: {
        projectRoot: { text: '', overridden: false, invalid: false },
        'codex.home': { text: '/home/u/.codex', overridden: false, invalid: false },
        'codex.configPath': { text: '/home/u/.codex/config.toml', overridden: false, invalid: false },
        'claudeCode.configDir': { text: '/home/u/.claude', overridden: false, invalid: false },
        'claudeCode.configPath': { text: '/home/u/.claude.json', overridden: false, invalid: false },
        maxServers: { text: '8', overridden: true, invalid: false },
        maxSkills: { text: '200', overridden: false, invalid: false },
      },
      switches: {
        mcp: { checked: true, overridden: false },
        skills: { checked: true, overridden: false },
        skillAutoImport: { checked: true, overridden: false },
        'codex.includeSystemSkills': { checked: false, overridden: false },
        failOnStartupError: { checked: false, overridden: false },
      },
    })
    expect(skillSources).toEqual({
      overridden: false,
      choices: SKILL_IMPORT_SOURCES.map(option => ({
        value: option.id,
        checked: option.id === 'codex' || option.id === 'claude-code',
      })),
    })

    controller.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('reads a namespace the Host does not serve as unavailable, with blank controls', () => {
    const host = stubConfigForm<AgentImportSettings>()
    host.publish({ status: 'loading' })
    const controller = new AgentImportCardController(host.scope, unread)

    expect(controller.inject().hooks.agentImportCard.getSnapshot()).toMatchObject({
      available: false,
      writable: false,
      invalid: false,
      sources: {
        choices: [{ value: 'codex', checked: false }, { value: 'claude-code', checked: false }],
        overridden: false,
      },
      skillSources: { overridden: false },
      serverDenyList: { rows: [''], overridden: false },
      values: {
        'codex.home': { text: '', overridden: false, invalid: false },
        maxServers: { text: '', overridden: false, invalid: false },
      },
      switches: { mcp: { checked: false, overridden: false }, skillAutoImport: { checked: false, overridden: false } },
    })
    // Nothing is served, so no skill source is offered as read either.
    expect(
      controller.inject().hooks.agentImportCard.getSnapshot().skillSources.choices.every(choice => !choice.checked),
    ).toBe(true)
  })

  it('stages every kind of control and writes each edit onto its section path', async () => {
    const host = served()
    const controller = new AgentImportCardController(host.scope, unread)
    const { hooks, ...face } = controller.inject()

    face.edit('codex.home', ' D:/codex ')
    face.setToggle('failOnStartupError', true)
    face.setChoices('sources', ['claude-code'])
    face.setChoices('skillSources', ['cursor'])
    face.setToggle('skillAutoImport', false)
    face.setList('serverDenyList', ['fs', ' ', 'telemetry'])
    face.edit('maxSkills', '150')
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: false,
      sources: { choices: [{ value: 'codex', checked: false }, { value: 'claude-code', checked: true }] },
      serverDenyList: { rows: ['fs', ' ', 'telemetry'], overridden: true },
      switches: {
        failOnStartupError: { checked: true, overridden: true },
        skillAutoImport: { checked: false, overridden: true },
      },
    })
    // Only the skill source the edit named is read; the other twenty-one are not.
    expect(hooks.agentImportCard.getSnapshot().skillSources.choices.filter(choice => choice.checked))
      .toEqual([{ value: 'cursor', checked: true }])

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls[0]).toEqual([[
      { op: 'set', path: ['codex', 'home'], value: 'D:/codex' },
      { op: 'set', path: ['failOnStartupError'], value: true },
      { op: 'set', path: ['sources'], value: ['claude-code'] },
      { op: 'set', path: ['skillSources'], value: ['cursor'] },
      { op: 'set', path: ['skillAutoImport'], value: false },
      { op: 'set', path: ['serverDenyList'], value: ['fs', 'telemetry'] },
      { op: 'set', path: ['maxSkills'], value: 150 },
    ], 7])
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('refuses to write a draft a bound does not accept', async () => {
    const host = served()
    const controller = new AgentImportCardController(host.scope, unread)
    const { hooks, ...face } = controller.inject()

    face.edit('maxServers', 'many')
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: true,
      values: { maxServers: { text: 'many', overridden: false, invalid: true } },
    })

    face.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('clears an override, keeps it when the Host refuses the write, and drops it on discard', async () => {
    const host = served()
    host.mutate.mockImplementation(() => Promise.resolve(false))
    const controller = new AgentImportCardController(host.scope, unread)
    const { hooks, ...face } = controller.inject()

    face.clear('maxServers')
    // The clear previews the composition layer the field would fall back to.
    expect(hooks.agentImportCard.getSnapshot().values.maxServers).toEqual({ text: '64', overridden: false, invalid: false })

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })
    expect(host.mutate.mock.calls[0]?.[0]).toEqual([{ op: 'unset', path: ['maxServers'] }])
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({ dirty: true, failed: true })
    expect(hooks.agentImportCard.getSnapshot().values.maxServers).toEqual({ text: '64', overridden: false, invalid: false })

    face.discard()
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    expect(hooks.agentImportCard.getSnapshot().values.maxServers).toEqual({ text: '8', overridden: true, invalid: false })  })

  it('stages a switch back to the state the section holds', () => {
    const controller = new AgentImportCardController(served().scope, unread)
    const { hooks, ...face } = controller.inject()

    face.setToggle('mcp', false)
    expect(hooks.agentImportCard.getSnapshot().switches.mcp).toEqual({ checked: false, overridden: true })

    face.setToggle('mcp', true)
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({
      dirty: false,
      switches: { mcp: { checked: true, overridden: true } },
    })
  })
})

describe('AgentImportCardController, on the Skills tab', () => {
  it('reads no catalog until the tab asks, then reads the one the Host serves', async () => {
    const port = skillsPort()
    port.loadCatalog.mockResolvedValue({ phase: 'ready', catalog: skillCatalog() })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    // Building the catalog scans every agent's skill directories, so a page the
    // user never opens must not pay for it.
    expect(hooks.agentImportSkills.getSnapshot()).toEqual({ phase: 'idle' })
    expect(port.loadCatalog).not.toHaveBeenCalled()

    face.refreshSkills()
    expect(hooks.agentImportSkills.getSnapshot()).toEqual({ phase: 'loading' })
    await vi.waitFor(() => {
      expect(hooks.agentImportSkills.getSnapshot()).toEqual({ phase: 'ready', catalog: skillCatalog() })
    })
  })

  it('keeps the reason a catalog read failed, and whether the Host was reached at all', async () => {
    const port = skillsPort()
    port.loadCatalog.mockResolvedValue({ phase: 'unavailable', reason: 'the scan threw', offline: true })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.refreshSkills()

    await vi.waitFor(() => {
      expect(hooks.agentImportSkills.getSnapshot()).toEqual({
        phase: 'unavailable', reason: 'the scan threw', offline: true,
      })
    })
  })

  it('imports the skill it is told to, reports the outcome, and reads the catalog again', async () => {
    const port = skillsPort()
    const outcome = skillOutcome({ imported: ['demo'], skipped: [{ name: 'other', reason: 'local-copy' }] })
    port.loadCatalog.mockResolvedValue({ phase: 'ready', catalog: skillCatalog() })
    port.importSkill.mockResolvedValue({ phase: 'ready', outcome })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.importSkill({ name: 'demo', source: 'cursor', replace: true })
    expect(port.importSkill).toHaveBeenCalledWith({ name: 'demo', source: 'cursor', replace: true })
    expect(hooks.agentImportSkillAction.getSnapshot()).toEqual({ phase: 'busy', name: 'demo' })

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillAction.getSnapshot()).toEqual({ phase: 'done', outcome })
    })
    expect(port.loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('removes the import it is told to, by name', async () => {
    const port = skillsPort()
    port.loadCatalog.mockResolvedValue({ phase: 'ready', catalog: skillCatalog() })
    port.removeSkill.mockResolvedValue({ phase: 'ready', outcome: skillOutcome({ removed: ['demo'] }) })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.removeSkill('demo')

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillAction.getSnapshot()).toEqual({
        phase: 'done', outcome: skillOutcome({ removed: ['demo'] }),
      })
    })
    expect(port.removeSkill).toHaveBeenCalledWith('demo')
    expect(port.loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('reads a catalog holding a name the user switched off, and re-reads it once it is on again', async () => {
    const port = skillsPort()
    const off = skillCatalog({ skills: [skillReport({ name: 'off-one', state: 'disabled' })] })
    const back = skillCatalog({ skills: [skillReport({ name: 'off-one', state: 'linked' })] })
    port.loadCatalog.mockResolvedValueOnce({ phase: 'ready', catalog: off })
      .mockResolvedValueOnce({ phase: 'ready', catalog: back })
    port.importSkill.mockResolvedValue({ phase: 'ready', outcome: skillOutcome({ imported: ['off-one'] }) })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.refreshSkills()
    // The state travels to the tab unchanged: it is the tab that decides how a
    // switched-off name reads and what its switch does.
    await vi.waitFor(() => {
      expect(hooks.agentImportSkills.getSnapshot()).toEqual({ phase: 'ready', catalog: off })
    })

    face.importSkill({ name: 'off-one' })

    await vi.waitFor(() => {
      expect(hooks.agentImportSkills.getSnapshot()).toEqual({ phase: 'ready', catalog: back })
    })
    // Switching the name back on is importing the winning copy again, which is
    // also what withdraws the Host's remembered removal.
    expect(port.importSkill).toHaveBeenCalledWith({ name: 'off-one' })
  })

  it('reports a mutation the Host refused, and reads the catalog anyway', async () => {
    const port = skillsPort()
    port.removeSkill.mockResolvedValue({ phase: 'unavailable', reason: 'that path is not a link' })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.removeSkill('demo')

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillAction.getSnapshot()).toEqual({
        phase: 'failed', reason: 'that path is not a link',
      })
    })
    // A write that failed halfway can still have changed what is installed.
    expect(port.loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('marks a mutation that never reached the Host as offline', async () => {
    const port = skillsPort()
    port.importSkill.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.importSkill({ name: 'demo' })

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillAction.getSnapshot()).toEqual({
        phase: 'failed', reason: 'Error: connect ECONNREFUSED', offline: true,
      })
    })
  })

  it('reads one instruction body into the detail view, and closes it again', async () => {
    const port = skillsPort()
    const content = {
      name: 'demo', description: 'Demo skill.', source: 'cursor' as const, file: '/home/u/.cursor/skills/demo/SKILL.md', content: '# Demo\n',
    }
    port.loadContent.mockResolvedValue({ phase: 'ready', content })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    expect(hooks.agentImportSkillContent.getSnapshot()).toEqual({ phase: 'closed' })

    face.openSkill({ name: 'demo', source: 'cursor' })
    expect(hooks.agentImportSkillContent.getSnapshot()).toEqual({ phase: 'loading', name: 'demo' })

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillContent.getSnapshot()).toEqual({ phase: 'ready', content })
    })
    expect(port.loadContent).toHaveBeenCalledWith({ name: 'demo', source: 'cursor' })

    face.closeSkill()
    expect(hooks.agentImportSkillContent.getSnapshot()).toEqual({ phase: 'closed' })
  })

  it('names the skill whose body could not be read', async () => {
    const port = skillsPort()
    port.loadContent.mockResolvedValue({ phase: 'unavailable', reason: 'gone' })
    const controller = new AgentImportCardController(served().scope, unread, port)
    const { hooks, ...face } = controller.inject()

    face.openSkill({ name: 'gone' })

    await vi.waitFor(() => {
      expect(hooks.agentImportSkillContent.getSnapshot()).toEqual({
        phase: 'unavailable', name: 'gone', reason: 'gone',
      })
    })
  })
})
