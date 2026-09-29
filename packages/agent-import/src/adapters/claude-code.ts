/**
 * Claude Code adapter: the MCP servers and skill directories of a Claude Code home.
 *
 * Claude Code keeps its user-scope servers in the `mcpServers` object of
 * `~/.claude.json` (plus a `projects.<path>.mcpServers` override per workspace)
 * and project-scope servers in `<project>/.mcp.json`. Both files use the same
 * entry vocabulary, so one entry reader serves both; the two exported readers
 * differ only in which object they descend into.
 *
 * @module @deepseek-ai/dsh-agent-import/adapters/claude-code
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { AdapterContext, ForeignAgentAdapter } from '../adapter.ts'
import type { ForeignMcpServer, ForeignServerRead, ForeignSkillRoot } from '../types.ts'
import { nonEmptyString, stringList } from '../values.ts'

/** Claude Code transports that map onto a dsh transport. */
const STDIO_TYPES: ReadonlySet<string> = new Set(['stdio'])

/** Claude Code transports that map onto the dsh Streamable HTTP transport. */
const HTTP_TYPES: ReadonlySet<string> = new Set(['http'])

/** Claude Code-specific import configuration. */
export interface ClaudeCodeOptions {
  /** Configuration directory holding `skills/`. Defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string
  /** User configuration file holding user-scope servers. Defaults to `~/.claude.json`. */
  configPath?: string
}

/** Accepted Claude Code import options. */
export const ClaudeCodeOptionsSchema: Schema<ClaudeCodeOptions> = z.object({
  configDir: z.string(),
  configPath: z.string(),
})

/**
 * Build the Claude Code adapter.
 * @param options - Claude Code-specific import configuration.
 * @returns the adapter the plugin composes when `sources` names `claude-code`.
 */
export function claudeCodeAdapter(options: ClaudeCodeOptions): ForeignAgentAdapter {
  const configDir = (context: AdapterContext): string =>
    resolve(options.configDir ?? context.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'))
  return {
    source: 'claude-code',
    readServers: async (context) => {
      const userPath = options.configPath ?? join(homedir(), '.claude.json')
      const user = await context.readOptional(userPath)
      if (user === undefined) return []
      const reads: ForeignServerRead[] = [readClaudeProjectServers(user, userPath, context.projectRoot)]
      const projectPath = join(context.projectRoot, '.mcp.json')
      const project = await context.readOptional(projectPath)
      if (project !== undefined) reads.push(readClaudeServers(project, projectPath))
      reads.push(readClaudeServers(user, userPath))
      return reads
    },
    skillRoots: context => claudeSkillRoots(configDir(context), context.projectRoot),
  }
}

/**
 * Read the top-level `mcpServers` object of a Claude Code JSON configuration.
 * @param text - contents of `~/.claude.json` or a project `.mcp.json`.
 * @param origin - declaring file path, carried into diagnostics and every server.
 * @returns the normalized servers plus one note per declaration this reader could not translate.
 */
export function readClaudeServers(text: string, origin: string): ForeignServerRead {
  const root = readJsonObject(text, origin)
  if (typeof root === 'string') return { servers: [], notes: [root] }
  return readServerEntries(root.mcpServers, origin)
}

/**
 * Read one workspace's `projects.<path>.mcpServers` override from `~/.claude.json`.
 * @param text - contents of `~/.claude.json`.
 * @param origin - declaring file path, carried into diagnostics and every server.
 * @param projectRoot - workspace directory whose override to read.
 * @returns the normalized servers plus one note per declaration this reader could not translate.
 */
export function readClaudeProjectServers(text: string, origin: string, projectRoot: string): ForeignServerRead {
  const root = readJsonObject(text, origin)
  if (typeof root === 'string') return { servers: [], notes: [root] }
  const projects = root.projects
  if (!isRecord(projects)) return { servers: [], notes: [] }
  const wanted = projectKey(projectRoot)
  for (const [key, entry] of Object.entries(projects)) {
    if (projectKey(key) !== wanted || !isRecord(entry)) continue
    return readServerEntries(entry.mcpServers, origin)
  }
  return { servers: [], notes: [] }
}

/**
 * Derive the skill directories Claude Code serves for one home and workspace.
 * @param configDir - resolved Claude Code configuration directory.
 * @param projectRoot - workspace directory, or `undefined` to read only the user directory.
 * @returns the Claude Code skill roots in precedence order.
 */
export function claudeSkillRoots(configDir: string, projectRoot: string | undefined): ForeignSkillRoot[] {
  const roots: ForeignSkillRoot[] = [{ path: join(configDir, 'skills'), source: 'claude-code', skipDotEntries: true }]
  if (projectRoot !== undefined) {
    roots.push({ path: join(projectRoot, '.claude', 'skills'), source: 'claude-code', skipDotEntries: true })
  }
  return roots
}

/** Read one `mcpServers` object into normalized servers. */
function readServerEntries(entries: unknown, origin: string): ForeignServerRead {
  const servers: ForeignMcpServer[] = []
  const notes: string[] = []
  if (entries === undefined) return { servers, notes }
  if (!isRecord(entries)) return { servers, notes: [`${origin}: "mcpServers" is not an object`] }
  for (const [name, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      notes.push(`${origin}: server "${name}" skipped: declaration is not an object`)
      continue
    }
    const result = readClaudeServer(name, entry, origin)
    if (typeof result === 'string') {
      notes.push(`${origin}: server "${name}" skipped: ${result}`)
      continue
    }
    servers.push(result)
    if (entry.startup_timeout_sec !== undefined) {
      notes.push(`${origin}: server "${name}" startup_timeout_sec has no dsh equivalent and was not applied`)
    }
  }
  return { servers, notes }
}

/** Read one declaration into a server, or return why it cannot be mounted. */
function readClaudeServer(name: string, entry: Readonly<Record<string, unknown>>, origin: string): ForeignMcpServer | string {
  const type = entry.type
  if (type !== undefined && typeof type !== 'string') return '"type" must be a string'
  if (type !== undefined && !STDIO_TYPES.has(type) && !HTTP_TYPES.has(type)) return `unsupported transport "${type}"`
  if (type === undefined || STDIO_TYPES.has(type)) {
    const command = nonEmptyString(entry.command)
    if (command === undefined) return 'missing "command"'
    const args = stringList(entry.args)
    if (args === undefined) return '"args" must be an array of strings'
    const env = stringRecord(entry.env, 'env')
    if (typeof env === 'string') return env
    return { transport: 'stdio', name, source: 'claude-code', origin, command, args, env }
  }
  const url = nonEmptyString(entry.url)
  if (url === undefined) return 'missing "url"'
  const headers = stringRecord(entry.headers, 'headers')
  if (typeof headers === 'string') return headers
  return { transport: 'streamable-http', name, source: 'claude-code', origin, url, headers }
}

/** Read a string-to-string JSON object. */
function stringRecord(value: unknown, label: string): Record<string, string> | string {
  const entries: Record<string, string> = {}
  if (value === undefined) return entries
  if (!isRecord(value)) return `"${label}" must be an object`
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return `${label}.${key} must be a string`
    entries[key] = entry
  }
  return entries
}

/** Parse one JSON document into an object, or return the note explaining why it is unusable. */
function readJsonObject(text: string, origin: string): Readonly<Record<string, unknown>> | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return `${origin}: not valid JSON (${String(error)})`
  }
  if (!isRecord(parsed)) return `${origin}: configuration is not a JSON object`
  return parsed
}

/** Normalize a workspace path the way Claude Code keys its `projects` records. */
function projectKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/** Report whether a JSON value is an object rather than an array or scalar. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
