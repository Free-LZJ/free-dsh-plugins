/**
 * The adapter every supported agent tool implements.
 *
 * One module under `adapters/` owns each tool: where that tool keeps its files,
 * which environment variable overrides its home, how its declarations translate,
 * and which directories hold its skills. The plugin composes the adapters named
 * by `Config.sources` into a uniform list, so supporting another tool means
 * adding one module that returns a {@link ForeignAgentAdapter} — no change to
 * the mounting, skill-provider, or bounds logic.
 *
 * @module @deepseek-ai/dsh-agent-import/adapter
 */

import type { EnvLookup, ForeignServerRead, ForeignSkillRoot, ForeignSource } from './types.ts'

/** Inputs an adapter resolves its own files and environment from. */
export interface AdapterContext {
  /** Workspace root, for tools whose configuration is workspace-local. */
  readonly projectRoot: string
  /** Process environment, for home overrides and for values the tool expects to pass through. */
  readonly env: EnvLookup
  /**
   * Read one optional configuration file, decoded as UTF-8.
   * @param path - absolute file path.
   * @returns the file text, or `undefined` when it is absent or unreadable.
   */
  readonly readOptional: (path: string) => Promise<string | undefined>
}

/** One other agent tool this plugin can import from. */
export interface ForeignAgentAdapter {
  /** Source label this adapter reports, and the `Config.sources` value that selects it. */
  readonly source: ForeignSource
  /**
   * Read every MCP server this tool declares.
   * @param context - resolution inputs for this read.
   * @returns the normalized declarations plus one note per declaration that could not be translated.
   */
  readonly readServers: (context: AdapterContext) => Promise<ForeignServerRead[]>
  /**
   * List the directories holding this tool's skills.
   * @param context - resolution inputs for this read.
   * @returns the skill roots in the order they should win name collisions.
   */
  readonly skillRoots: (context: AdapterContext) => ForeignSkillRoot[]
}
