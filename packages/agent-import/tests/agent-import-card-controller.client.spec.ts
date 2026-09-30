/** The page state the agent-import row projects, and the writes its actions stage. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from './support/runtime.ts'
import { AgentImportCardController } from '../src/client/agent-import-card-controller.ts'
import type { AgentImportSettings } from '../src/client/agent-import-fields.ts'
import type { AgentImportReportResult } from '../src/client/agent-import-report.ts'

/** The section the Host resolves before any user override. */
const DEFAULTS: AgentImportSettings = {
  sources: ['codex', 'claude-code'],
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

describe('AgentImportCardController', () => {
  it('projects every control the page renders from the section the Host serves', () => {
    const host = served()
    const controller = new AgentImportCardController(host.scope, unread)
    const { agentImportCard } = controller.inject().hooks

    expect(agentImportCard.getSnapshot()).toEqual({
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
        'codex.includeSystemSkills': { checked: false, overridden: false },
        failOnStartupError: { checked: false, overridden: false },
      },
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
      serverDenyList: { rows: [''], overridden: false },
      values: {
        'codex.home': { text: '', overridden: false, invalid: false },
        maxServers: { text: '', overridden: false, invalid: false },
      },
      switches: { mcp: { checked: false, overridden: false } },
    })
  })

  it('stages every kind of control and writes each edit onto its section path', async () => {
    const host = served()
    const controller = new AgentImportCardController(host.scope, unread)
    const { hooks, ...face } = controller.inject()

    face.edit('codex.home', ' D:/codex ')
    face.setToggle('failOnStartupError', true)
    face.setChoices('sources', ['claude-code'])
    face.setList('serverDenyList', ['fs', ' ', 'telemetry'])
    face.edit('maxSkills', '150')
    expect(hooks.agentImportCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: false,
      sources: { choices: [{ value: 'codex', checked: false }, { value: 'claude-code', checked: true }] },
      serverDenyList: { rows: ['fs', ' ', 'telemetry'], overridden: true },
      switches: { failOnStartupError: { checked: true, overridden: true } },
    })

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls[0]).toEqual([[
      { op: 'set', path: ['codex', 'home'], value: 'D:/codex' },
      { op: 'set', path: ['failOnStartupError'], value: true },
      { op: 'set', path: ['sources'], value: ['claude-code'] },
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
