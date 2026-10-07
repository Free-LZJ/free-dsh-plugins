/**
 * Codex adapter: the MCP servers of a Codex home.
 *
 * Codex writes Windows paths as TOML literal strings (`'C:\path'`), so a naive
 * unescape produces a command nothing can launch; the {@link scanTomlSections}
 * scanner this adapter builds on keeps literal strings verbatim. Every
 * `mcp_servers` key it cannot translate becomes a note on the returned
 * {@link ForeignServerRead} so the operator sees exactly what did not carry over.
 *
 * @module @deepseek-ai/dsh-agent-import/adapters/codex
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { scanTomlSections } from '../toml.ts'
import type { TomlSection, TomlTable, TomlValue } from '../toml.ts'
import { nonEmptyString, stringList } from '../values.ts'
import type { AdapterContext, ForeignAgentAdapter } from '../adapter.ts'
import type { EnvLookup, ForeignMcpServer, ForeignServerRead } from '../types.ts'

/** Codex table that declares MCP servers. */
const MCP_TABLE = 'mcp_servers'

/** Codex `type` values that select the stdio transport; an absent `type` also selects it. */
const STDIO_TYPES: ReadonlySet<string> = new Set(['stdio'])

/** Codex `type` values that select a remote transport. */
const HTTP_TYPES: ReadonlySet<string> = new Set(['http', 'streamable-http', 'streamable_http'])

/** Codex keys this reader translates; every other key becomes a note. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'type',
  'command',
  'args',
  'env',
  'env_vars',
  'startup_timeout_sec',
  'url',
  'http_headers',
  'bearer_token_env_var',
])

/** Codex-specific import configuration. */
export interface CodexOptions {
  /** Codex home directory. Defaults to `$CODEX_HOME` or `~/.codex`. */
  home?: string
  /** Codex configuration file. Defaults to `<home>/config.toml`. */
  configPath?: string
  /** Whether Codex's own `.system` skill bundles join the catalog. Defaults to false. */
  includeSystemSkills?: boolean
}

/** Accepted Codex import options. */
export const CodexOptionsSchema: Schema<CodexOptions> = z.object({
  home: z.string(),
  configPath: z.string(),
  includeSystemSkills: z.boolean().default(false),
})

/**
 * Build the Codex adapter.
 * @param options - Codex-specific import configuration.
 * @returns the adapter the plugin composes when `sources` names `codex`.
 */
export function codexAdapter(options: CodexOptions): ForeignAgentAdapter {
  const home = (context: AdapterContext): string =>
    resolve(options.home ?? context.env['CODEX_HOME'] ?? join(homedir(), '.codex'))
  return {
    source: 'codex',
    readServers: async (context) => {
      const path = options.configPath ?? join(home(context), 'config.toml')
      const text = await context.readOptional(path)
      return text === undefined ? [] : [readCodexServers(text, path, context.env)]
    },
  }
}

/**
 * Read every `[mcp_servers.<name>]` declaration from one Codex `config.toml`.
 * @param text - `config.toml` contents.
 * @param origin - declaring file path, carried into diagnostics and every server.
 * @param env - environment used to expand `env_vars` and `bearer_token_env_var` entries.
 * @returns the normalized servers plus one note per declaration this reader could not translate.
 */
export function readCodexServers(text: string, origin: string, env: EnvLookup): ForeignServerRead {
  const document = scanTomlSections(text)
  const tables = new Map<string, TomlSection>()
  const environments = new Map<string, TomlSection>()
  const headerTables = new Map<string, TomlSection>()
  for (const section of document.sections) {
    const [head, name, leaf] = section.path
    if (head !== MCP_TABLE || name === undefined) continue
    if (section.path.length === 2) tables.set(name, section)
    else if (leaf === 'env') environments.set(name, section)
    else if (leaf === 'http_headers') headerTables.set(name, section)
  }
  const servers: ForeignMcpServer[] = []
  const notes = document.skipped.map(statement => `${origin}: unreadable statement "${statement}"`)
  for (const [name, table] of tables) {
    const result = readCodexServer(name, table, environments.get(name), headerTables.get(name), origin, env)
    if (typeof result === 'string') {
      notes.push(`${origin}: server "${name}" skipped: ${result}`)
      continue
    }
    servers.push(result)
    const ignored = [...table.values.keys()].filter(key => !KNOWN_KEYS.has(key))
    if (ignored.length > 0) notes.push(`${origin}: server "${name}" ignored unsupported keys: ${ignored.join(', ')}`)
    if (table.values.has('startup_timeout_sec')) {
      notes.push(`${origin}: server "${name}" startup_timeout_sec has no dsh equivalent and was not applied`)
    }
  }
  return { servers, notes }
}

/** Read one declaration into a server, or return why it cannot be mounted. */
function readCodexServer(
  name: string,
  table: TomlSection,
  environment: TomlSection | undefined,
  headerTable: TomlSection | undefined,
  origin: string,
  env: EnvLookup,
): ForeignMcpServer | string {
  const type = nonEmptyString(table.values.get('type'))
  if (type !== undefined && !STDIO_TYPES.has(type) && !HTTP_TYPES.has(type)) return `unsupported transport "${type}"`
  if (type === undefined || STDIO_TYPES.has(type)) {
    const command = nonEmptyString(table.values.get('command'))
    if (command === undefined) return 'missing "command"'
    const args = stringList(table.values.get('args'))
    if (args === undefined) return '"args" must be an array of strings'
    const declared = readStringTable(table.values.get('env'), environment, 'env')
    if (typeof declared === 'string') return declared
    const inherited = inheritEnvironment(table.values.get('env_vars'), env)
    if (typeof inherited === 'string') return inherited
    return {
      transport: 'stdio',
      name,
      source: 'codex',
      origin,
      command,
      args,
      env: { ...inherited, ...declared },
    }
  }
  const url = nonEmptyString(table.values.get('url'))
  if (url === undefined) return 'missing "url"'
  const declaredHeaders = readStringTable(table.values.get('http_headers'), headerTable, 'http_headers')
  if (typeof declaredHeaders === 'string') return declaredHeaders
  const authorization = bearerHeader(table.values.get('bearer_token_env_var'), env)
  if (typeof authorization === 'string') return authorization
  return {
    transport: 'streamable-http',
    name,
    source: 'codex',
    origin,
    url,
    headers: { ...declaredHeaders, ...authorization },
  }
}

/** Read `env_vars` into the subset of named variables the parent process defines. */
function inheritEnvironment(value: TomlValue | undefined, env: EnvLookup): Record<string, string> | string {
  const names = stringList(value)
  if (names === undefined) return '"env_vars" must be an array of strings'
  const inherited: Record<string, string> = {}
  for (const name of names) {
    const entry = env[name]
    if (entry !== undefined) inherited[name] = entry
  }
  return inherited
}

/** Read a bearer token from the named environment variable. */
function bearerHeader(value: TomlValue | undefined, env: EnvLookup): Record<string, string> | string {
  if (value === undefined) return {}
  const variable = nonEmptyString(value)
  if (variable === undefined) return '"bearer_token_env_var" must be a non-empty string'
  const token = env[variable]
  if (token === undefined) return `bearer_token_env_var "${variable}" is not set in the environment`
  return { Authorization: `Bearer ${token}` }
}

/** Read a string table declared inline (`env = { … }`) or as its own Codex sub-table. */
function readStringTable(
  inline: TomlValue | undefined,
  section: TomlSection | undefined,
  label: string,
): Record<string, string> | string {
  const entries: Record<string, string> = {}
  if (inline !== undefined) {
    if (!isTable(inline)) return `"${label}" must be a table`
    for (const [key, value] of Object.entries(inline)) {
      if (typeof value !== 'string') return `${label}.${key} must be a string`
      entries[key] = value
    }
  }
  if (section === undefined) return entries
  for (const [key, value] of section.values) {
    if (typeof value !== 'string') return `${label}.${key} must be a string`
    entries[key] = value
  }
  return entries
}

/** Report whether a value is a TOML table rather than an array or scalar. */
function isTable(value: TomlValue): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value)
}
