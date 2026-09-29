/** What the settings fields encode in the shared form's draft text. */

import { describe, expect, it } from 'vitest'
import {
  AGENT_IMPORT_FIELDS, FOREIGN_SOURCES, listDraft, listRows, sourceDraft, sourceSelection,
  type AgentImportFieldId, type AgentImportFieldKind,
} from '../src/client/agent-import-fields.ts'

/** Every field of the row, and the control the page edits it through. */
const KINDS: Readonly<Record<AgentImportFieldId, AgentImportFieldKind>> = {
  sources: 'sources',
  projectRoot: 'text',
  'codex.home': 'text',
  'codex.configPath': 'text',
  'claudeCode.configDir': 'text',
  'claudeCode.configPath': 'text',
  maxServers: 'count',
  maxSkills: 'count',
  mcp: 'switch',
  skills: 'switch',
  'codex.includeSystemSkills': 'switch',
  failOnStartupError: 'switch',
  serverDenyList: 'list',
}

/** The shared form's conversion for one field. */
function spec(field: AgentImportFieldId) {
  return AGENT_IMPORT_FIELDS[field].spec
}

describe('agent-import fields', () => {
  it('declares every field the Host serves, under its dotted path', () => {
    const declared = Object.fromEntries(Object.entries(AGENT_IMPORT_FIELDS).map(([name, field]) => [name, field.kind]))

    expect(declared).toEqual(KINDS)
    expect(Object.values(AGENT_IMPORT_FIELDS).map(field => field.field).sort()).toEqual(Object.keys(KINDS).sort())
  })

  it('renders a text field from the section and stages its trimmed text', () => {
    expect(spec('projectRoot').format('/repo')).toBe('/repo')
    expect(spec('projectRoot').format(undefined)).toBe('')
    expect(spec('codex.home').parse(' /home/u/.codex ')).toEqual({ kind: 'set', value: '/home/u/.codex' })
    expect(spec('codex.home').parse('  ')).toEqual({ kind: 'clear' })
  })

  it('renders a bound as a number and refuses a draft that is not a whole number of items', () => {
    expect(spec('maxServers').format(64)).toBe('64')
    expect(spec('maxServers').format(undefined)).toBe('')
    expect(spec('maxServers').parse('150')).toEqual({ kind: 'set', value: 150 })
    expect(spec('maxServers').parse('')).toEqual({ kind: 'clear' })
    for (const draft of ['many', '-1', '1.5', '-0']) expect(spec('maxServers').parse(draft)).toBeUndefined()
  })

  it('reads a switch off unless the section switched it on, and stages it as text', () => {
    expect(spec('mcp').format(true)).toBe('true')
    expect(spec('mcp').format(false)).toBe('false')
    expect(spec('mcp').format(undefined)).toBe('false')
    expect(spec('mcp').parse('true')).toEqual({ kind: 'set', value: true })
    expect(spec('mcp').parse('false')).toEqual({ kind: 'set', value: false })
  })

  it('carries the tool names and the denied server names in their drafts', () => {
    expect(spec('sources').format(['codex', 'claude-code'])).toBe('codex,claude-code')
    expect(spec('sources').format(undefined)).toBe('')
    expect(spec('sources').parse(' claude-code , codex ')).toEqual({ kind: 'set', value: ['claude-code', 'codex'] })
    expect(spec('sources').parse('')).toEqual({ kind: 'set', value: [] })

    expect(spec('serverDenyList').format(['fs', 'telemetry'])).toBe('fs\ntelemetry')
    expect(spec('serverDenyList').format(undefined)).toBe('')
    expect(spec('serverDenyList').parse('fs\n\ntelemetry\n')).toEqual({ kind: 'set', value: ['fs', 'telemetry'] })
  })

  it('keeps the tools in precedence order and drops the names a draft leaves blank', () => {
    expect(FOREIGN_SOURCES).toEqual(['codex', 'claude-code'])
    expect(sourceDraft(['claude-code'])).toBe('claude-code')
    expect(sourceSelection('claude-code,codex')).toEqual(['claude-code', 'codex'])
    expect(sourceSelection('')).toEqual([])
    expect(listDraft(['fs', 'telemetry'])).toBe('fs\ntelemetry')
    expect(listRows('fs\ntelemetry')).toEqual(['fs', 'telemetry'])
    // An empty deny list keeps the row the user is about to type into.
    expect(listRows('')).toEqual([''])
    expect(listRows('fs\n')).toEqual(['fs', ''])
  })
})
