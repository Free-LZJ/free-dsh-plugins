/**
 * The fields of the `agent-import` settings namespace, as the shared staged
 * form model addresses them.
 *
 * A field's name is its path inside the row's settings section joined with
 * '.', so `codex.home` names the Codex home directory: the section keeps its
 * two per-tool option objects nested, while the shared model reads and writes
 * one flat section member per control (see `agent-import-flat-scope.ts`).
 *
 * The model stages text, so the controls whose value is not text — the
 * switches, the source selection, and the deny list — encode that value in the
 * draft and decode it again on the way back.
 */

import { settingsTextField, type SettingsFieldSpec } from '@deepseek-ai/dsh-client-ui-primitives'

/** The foreign agent tools this plugin reads. */
export type ForeignSource = 'codex' | 'claude-code'

/** Every tool `sources` accepts, in precedence order. */
export const FOREIGN_SOURCES: readonly ForeignSource[] = ['codex', 'claude-code']

/** The row's settings section as the Host resolves it. */
export interface AgentImportSettings {
  /** Which foreign tools to read. */
  sources?: readonly ForeignSource[]
  /** Codex discovery overrides. */
  codex?: {
    /** Codex home directory; the Codex default when absent. */
    home?: string
    /** Codex `config.toml` path; the Codex default when absent. */
    configPath?: string
    /** Whether Codex's system skills are imported alongside the user's. */
    includeSystemSkills?: boolean
  }
  /** Claude Code discovery overrides. */
  claudeCode?: {
    /** Claude Code configuration directory; the Claude Code default when absent. */
    configDir?: string
    /** Claude Code settings path; the Claude Code default when absent. */
    configPath?: string
  }
  /** Workspace root the imported entries are scoped to; empty means the process working directory. */
  projectRoot?: string
  /** Whether MCP servers are imported. */
  mcp?: boolean
  /** Whether skills are imported. */
  skills?: boolean
  /** Whether a startup failure aborts the run instead of being logged. */
  failOnStartupError?: boolean
  /** Imported MCP server names to leave unmounted. */
  serverDenyList?: readonly string[]
  /** Most MCP servers to import. */
  maxServers?: number
  /** Most skills to import. */
  maxSkills?: number
}

/** The free-text fields, naming a path or a directory. */
type AgentImportTextFieldId =
  | 'projectRoot'
  | 'codex.home'
  | 'codex.configPath'
  | 'claudeCode.configDir'
  | 'claudeCode.configPath'

/** The whole-number fields, bounding what one import reads. */
type AgentImportCountFieldId = 'maxServers' | 'maxSkills'

/** Fields edited through a text or number input. */
export type AgentImportInputFieldId = AgentImportTextFieldId | AgentImportCountFieldId

/** Fields edited through a switch. */
export type AgentImportToggleFieldId = 'mcp' | 'skills' | 'codex.includeSystemSkills' | 'failOnStartupError'

/** The multi-choice field naming the tools to read. */
export type AgentImportChoiceFieldId = 'sources'

/** The list field naming the imported servers to leave unmounted. */
export type AgentImportListFieldId = 'serverDenyList'

/** Every field the card edits. */
export type AgentImportFieldId =
  | AgentImportInputFieldId
  | AgentImportToggleFieldId
  | AgentImportChoiceFieldId
  | AgentImportListFieldId

/** The control a field's value is edited through. */
export type AgentImportFieldKind = 'text' | 'count' | 'switch' | 'sources' | 'list'

/** One field of the row: where it lives in the section, and how it is edited. */
export interface AgentImportField {
  /** The field's name: its path inside the settings section joined with '.'. */
  readonly field: AgentImportFieldId
  /** The control the page edits it through. */
  readonly kind: AgentImportFieldKind
  /** How the shared form converts the draft to and from the section value. */
  readonly spec: SettingsFieldSpec
}

/** Separator the source selection's draft carries between tool names. */
const SOURCE_SEPARATOR = ','

/** Separator the deny list's draft carries between server names. */
const LIST_SEPARATOR = '\n'

/**
 * A bound on imported items: a whole number that is never negative. A blank
 * draft re-inherits the profile's bound rather than pinning the section to
 * zero, which would import nothing.
 * @param field - name of the field.
 * @returns the field's conversion spec.
 */
function countSpec(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const bound = Number(trimmed)
      if (!Number.isSafeInteger(bound) || bound < 0 || Object.is(bound, -0)) return undefined
      return { kind: 'set', value: bound }
    },
  }
}

/**
 * A switch: the draft carries the switched state as text. A blank draft is a
 * switch that is off, not a clear, so the reset control is what re-inherits.
 * @param field - name of the field.
 * @returns the field's conversion spec.
 */
function switchSpec(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => ({ kind: 'set', value: text === 'true' }),
  }
}

/**
 * A list of names: the draft carries the names separated by one character. A
 * draft with no names is the empty list, never a clear, because dropping every
 * name is a choice the user made, while a clear would re-inherit the profile's
 * list.
 * @param field - name of the field.
 * @param separator - separator the draft carries between names.
 * @returns the field's conversion spec.
 */
function namesSpec(field: string, separator: string): SettingsFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(separator) : '',
    parse: text => ({ kind: 'set', value: names(text, separator) }),
  }
}

/** How each control kind converts its draft to and from the section value. */
const SPECS: Readonly<Record<AgentImportFieldKind, (field: string) => SettingsFieldSpec>> = {
  text: settingsTextField,
  count: countSpec,
  switch: switchSpec,
  sources: field => namesSpec(field, SOURCE_SEPARATOR),
  list: field => namesSpec(field, LIST_SEPARATOR),
}

/**
 * Declare one field of the settings namespace.
 * @param field - the field's name, which is also its section path.
 * @param kind - the control the card edits it through.
 * @returns the declared field.
 */
function field(field: AgentImportFieldId, kind: AgentImportFieldKind): AgentImportField {
  return { field, kind, spec: SPECS[kind](field) }
}

/**
 * Every field of the settings namespace, by name. A total table, so a field the
 * card cannot address is a compile error rather than a control that silently
 * edits nothing.
 */
export const AGENT_IMPORT_FIELDS: Readonly<Record<AgentImportFieldId, AgentImportField>> = {
  sources: field('sources', 'sources'),
  projectRoot: field('projectRoot', 'text'),
  'codex.home': field('codex.home', 'text'),
  'codex.configPath': field('codex.configPath', 'text'),
  'claudeCode.configDir': field('claudeCode.configDir', 'text'),
  'claudeCode.configPath': field('claudeCode.configPath', 'text'),
  maxServers: field('maxServers', 'count'),
  maxSkills: field('maxSkills', 'count'),
  mcp: field('mcp', 'switch'),
  skills: field('skills', 'switch'),
  'codex.includeSystemSkills': field('codex.includeSystemSkills', 'switch'),
  failOnStartupError: field('failOnStartupError', 'switch'),
  serverDenyList: field('serverDenyList', 'list'),
}

/**
 * The names a draft carries, trimmed, with the empty entries dropped.
 * @param text - the draft.
 * @param separator - separator between names.
 * @returns the names the draft holds.
 */
function names(text: string, separator: string): string[] {
  return text.split(separator).map(name => name.trim()).filter(name => name !== '')
}

/**
 * The draft a source selection stages.
 * @param values - the tools to read.
 * @returns the draft text.
 */
export function sourceDraft(values: readonly ForeignSource[]): string {
  return values.join(SOURCE_SEPARATOR)
}

/**
 * The tools a source selection's draft or section value holds.
 * @param text - the draft text.
 * @returns the tool names, in the order the draft carries them.
 */
export function sourceSelection(text: string): readonly string[] {
  return names(text, SOURCE_SEPARATOR)
}

/**
 * The draft a deny-list editor stages.
 * @param rows - the server names, one per row.
 * @returns the draft text.
 */
export function listDraft(rows: readonly string[]): string {
  return rows.join(LIST_SEPARATOR)
}

/**
 * The rows a deny list holds. Blank rows are kept so the editor shows the row
 * the user is typing into; the save drops them.
 * @param text - the draft or served text.
 * @returns the rows, at least one.
 */
export function listRows(text: string): readonly string[] {
  return text.split(LIST_SEPARATOR)
}
