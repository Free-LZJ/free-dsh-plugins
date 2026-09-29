/**
 * Values shared by the foreign-agent readers and the plugin entry point.
 *
 * Every reader normalizes its own tool's vocabulary into these types, so the
 * entry point mounts and registers without knowing which tool a value came
 * from. `origin` keeps the declaring file for diagnostics only.
 *
 * @module @deepseek-ai/dsh-agent-import/types
 */

/** Other agent tool whose configuration this package reads. */
export type ForeignSource = 'codex' | 'claude-code'

/** Environment lookup an adapter reads for home overrides, `env_vars`, and bearer tokens. */
export type EnvLookup = Readonly<Record<string, string | undefined>>

/** Fields every normalized MCP server declaration carries. */
export interface ForeignServerBase {
  /** Server name inside its declaring tool, used as the dsh server namespace. */
  readonly name: string
  /** Tool whose configuration declared this server. */
  readonly source: ForeignSource
  /** Declaring file path, for diagnostics. */
  readonly origin: string
}

/** One stdio MCP server declared by another agent tool. */
export interface ForeignStdioServer extends ForeignServerBase {
  readonly transport: 'stdio'
  /** Executable to launch; resolved through `PATH` by the child process. */
  readonly command: string
  /** Arguments passed after `command`. */
  readonly args: readonly string[]
  /** Environment entries merged over the harness's scrubbed ambient environment. */
  readonly env: Readonly<Record<string, string>>
}

/** One Streamable HTTP MCP server declared by another agent tool. */
export interface ForeignHttpServer extends ForeignServerBase {
  readonly transport: 'streamable-http'
  /** MCP endpoint URL. */
  readonly url: string
  /** Request headers, including any bearer token resolved from a named variable. */
  readonly headers: Readonly<Record<string, string>>
}

/** One normalized MCP server declaration from another agent tool. */
export type ForeignMcpServer = ForeignStdioServer | ForeignHttpServer

/** One skill directory owned by another agent tool. */
export interface ForeignSkillRoot {
  /** Absolute directory containing one `<skill>/SKILL.md` bundle per skill. */
  readonly path: string
  /** Tool whose configuration declares this root. */
  readonly source: ForeignSource
  /** Whether entries whose name starts with `.` are skipped. */
  readonly skipDotEntries: boolean
}

/** One declaring file's normalized servers plus one line per declaration that was not mounted. */
export interface ForeignServerRead {
  /** Servers in declaration order. */
  readonly servers: readonly ForeignMcpServer[]
  /** Unmounted declarations and untranslatable keys, as human-readable lines. */
  readonly notes: readonly string[]
}
