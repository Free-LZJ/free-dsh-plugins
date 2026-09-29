/**
 * Import the MCP servers and skills another agent tool already has.
 *
 * dsh normally reaches MCP servers and skills through its own configuration. A
 * user who also runs Codex or Claude Code has already declared both, so this
 * plugin selects the adapters named by `sources`, mounts every server they
 * declare through `@deepseek-ai/dsh-mcp-client`, and republishes every skill
 * directory they own on `ctx.skills`. Declarations that cannot be translated are
 * reported as warnings rather than failing activation, so one unusable
 * third-party entry never costs the user the rest of their imported tools.
 *
 * Every field is a volatile config reference, so a settings card can change one
 * without a restart: each change unmounts the previous import generation and
 * builds the next from a single snapshot of the new values.
 *
 * @module @deepseek-ai/dsh-agent-import
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event merge this plugin subscribes to.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { ClaudeCodeOptionsSchema, claudeCodeAdapter } from './adapters/claude-code.ts'
import type { ClaudeCodeOptions } from './adapters/claude-code.ts'
import { CodexOptionsSchema, codexAdapter } from './adapters/codex.ts'
import type { CodexOptions } from './adapters/codex.ts'
import type { AdapterContext, ForeignAgentAdapter } from './adapter.ts'
import { allocateServerName, mountForeignServers } from './mcp.ts'
import type { ServerMount } from './mcp.ts'
import { ForeignSkillProvider } from './skills.ts'
import type { ForeignSkillRoot, ForeignSource } from './types.ts'

/** Plugin name registered under the Cordis loader. */
export const name = 'agent-import'

/** Skill catalog the imported skills are published on. */
export const inject = ['skills']

/** Adapters every installation reads unless `sources` narrows them. */
const SOURCES: readonly ForeignSource[] = ['codex', 'claude-code']

/** Builds the adapter of one supported tool from one import configuration. */
const ADAPTERS: Readonly<Record<ForeignSource, (config: ImportSpec) => ForeignAgentAdapter>> = {
  codex: config => codexAdapter(config.codex),
  'claude-code': config => claudeCodeAdapter(config.claudeCode),
}

/** Upper bound on mounted servers when the configuration sets none. */
const DEFAULT_MAX_SERVERS = 64

/** Upper bound on published skills when the configuration sets none. */
const DEFAULT_MAX_SKILLS = 200

/** Other agent tools to import from, as live references the settings card can edit. */
export interface Config {
  /** Tools to read, in precedence order. */
  sources: Volatile<ForeignSource[]>
  /** Codex import options, resolved from their own defaults. */
  codex: Volatile<CodexOptions>
  /** Claude Code import options, resolved from their own defaults. */
  claudeCode: Volatile<ClaudeCodeOptions>
  /** Workspace whose project-local configuration is read; an empty value means the process working directory. */
  projectRoot: Volatile<string>
  /** Whether the imported MCP servers are mounted. */
  mcp: Volatile<boolean>
  /** Whether the imported skills are published. */
  skills: Volatile<boolean>
  /** Foreign server names to leave unmounted, matched against the declaring tool's own name. */
  serverDenyList: Volatile<string[]>
  /** Maximum imported MCP servers to mount. */
  maxServers: Volatile<number>
  /** Maximum imported skills to publish. */
  maxSkills: Volatile<number>
  /** Whether one server failing to start rejects plugin activation. */
  failOnStartupError: Volatile<boolean>
}

/** Configuration as written by a user, before the schema resolves the defaults. */
type ConfigInput = {
  sources?: ForeignSource[]
  codex?: CodexOptions
  claudeCode?: ClaudeCodeOptions
  projectRoot?: string
  mcp?: boolean
  skills?: boolean
  serverDenyList?: string[]
  maxServers?: number
  maxSkills?: number
  failOnStartupError?: boolean
}

export const Config = z.object({
  sources: z.array(z.union([z.const('codex'), z.const('claude-code')])).default([...SOURCES]).volatile(),
  codex: CodexOptionsSchema.default({}).volatile(),
  claudeCode: ClaudeCodeOptionsSchema.default({}).volatile(),
  projectRoot: z.string().default('').volatile(),
  mcp: z.boolean().default(true).volatile(),
  skills: z.boolean().default(true).volatile(),
  serverDenyList: z.array(z.string()).default([]).volatile(),
  maxServers: z.number().default(DEFAULT_MAX_SERVERS).volatile(),
  maxSkills: z.number().default(DEFAULT_MAX_SKILLS).volatile(),
  failOnStartupError: z.boolean().default(false).volatile(),
}) as z<ConfigInput, Config>

/** Import options captured from the live configuration for one import generation. */
interface ImportSpec {
  /** Tools to read, in precedence order. */
  readonly sources: readonly ForeignSource[]
  /** Codex import options. */
  readonly codex: CodexOptions
  /** Claude Code import options. */
  readonly claudeCode: ClaudeCodeOptions
  /** Workspace whose project-local configuration is read. */
  readonly projectRoot: string
  /** Whether the imported MCP servers are mounted. */
  readonly mcp: boolean
  /** Whether the imported skills are published. */
  readonly skills: boolean
  /** Foreign server names to leave unmounted. */
  readonly serverDenyList: readonly string[]
  /** Maximum imported MCP servers to mount. */
  readonly maxServers: number
  /** Maximum imported skills to publish. */
  readonly maxSkills: number
  /** Whether one server failing to start rejects plugin activation. */
  readonly failOnStartupError: boolean
}

/** One import generation: the mounted servers and the published skill provider. */
interface ImportGeneration {
  /** Mounted server children, in declaration order. */
  readonly servers: readonly Fiber[]
  /** Removes the published skill provider; absent when no enabled adapter owned a skill directory. */
  readonly disposeSkills?: (() => void) | undefined
}

/**
 * Mount the configured MCP servers and publish the configured skills, then keep
 * both in step with later configuration edits.
 * @param ctx - plugin context; mounted servers become children of its fiber.
 * @param config - live import configuration selecting the adapters and their bounds.
 * @returns readiness after the first generation settles; later generations follow configuration changes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let generation: ImportGeneration | undefined = await buildGeneration(ctx, snapshot(config))
  let pending: Promise<void> = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    pending = pending.then(async () => {
      try {
        await disposeGeneration(generation)
        generation = undefined
        generation = await buildGeneration(ctx, snapshot(config))
      } catch (error: unknown) {
        ctx.logger.error(`agent-import: re-import after a configuration change failed: ${String(error)}`)
      }
    })
  })
}

/** Capture one consistent set of import options from the live configuration references. */
function snapshot(config: Config): ImportSpec {
  return {
    sources: config.sources.get(),
    codex: config.codex.get(),
    claudeCode: config.claudeCode.get(),
    projectRoot: config.projectRoot.get(),
    mcp: config.mcp.get(),
    skills: config.skills.get(),
    serverDenyList: config.serverDenyList.get(),
    maxServers: config.maxServers.get(),
    maxSkills: config.maxSkills.get(),
    failOnStartupError: config.failOnStartupError.get(),
  }
}

/** Mount servers and publish skills for one snapshot, rolling back a partial result. */
async function buildGeneration(ctx: Context, spec: ImportSpec): Promise<ImportGeneration> {
  const adapters = selectAdapters(spec)
  const context = adapterContext(ctx, spec)
  let servers: readonly Fiber[] = []
  let disposeSkills: (() => void) | undefined
  try {
    if (spec.mcp) servers = await mountServers(ctx, spec, adapters, context)
    if (spec.skills) disposeSkills = publishSkills(ctx, spec, adapters, context)
  } catch (error: unknown) {
    await disposeGeneration({ servers, disposeSkills })
    throw error
  }
  return { servers, disposeSkills }
}

/** Remove one import generation: the skill provider first, then every mounted server. */
async function disposeGeneration(generation: ImportGeneration | undefined): Promise<void> {
  if (generation === undefined) return
  generation.disposeSkills?.()
  for (const fiber of generation.servers) await fiber.dispose()
}

/** Build the adapter of every enabled source, reading a repeated source once. */
function selectAdapters(spec: ImportSpec): ForeignAgentAdapter[] {
  const adapters: ForeignAgentAdapter[] = []
  for (const source of new Set(spec.sources)) adapters.push(ADAPTERS[source](spec))
  return adapters
}

/** Register the skill provider of the enabled adapters, once one of them owns a skill directory. */
function publishSkills(
  ctx: Context,
  spec: ImportSpec,
  adapters: readonly ForeignAgentAdapter[],
  context: AdapterContext,
): (() => void) | undefined {
  const roots: ForeignSkillRoot[] = []
  for (const adapter of adapters) roots.push(...adapter.skillRoots(context))
  if (roots.length === 0) return undefined
  const provider = new ForeignSkillProvider(ctx, roots, spec.maxSkills)
  return ctx.skills.registerProvider(() => provider)
}

/** Build the adapter-facing view of one import generation. */
function adapterContext(ctx: Context, spec: ImportSpec): AdapterContext {
  return {
    projectRoot: resolve(spec.projectRoot),
    env: process.env,
    readOptional: path => readOptionalFile(ctx, path),
  }
}

/** Read, translate, and mount every server the enabled adapters declare. */
async function mountServers(
  ctx: Context,
  spec: ImportSpec,
  adapters: readonly ForeignAgentAdapter[],
  context: AdapterContext,
): Promise<readonly Fiber[]> {
  const used = new Set<string>()
  const mounts: ServerMount[] = []
  const notes: string[] = []
  for (const adapter of adapters) {
    for (const read of await adapter.readServers(context)) {
      notes.push(...read.notes)
      for (const declaration of read.servers) {
        if (spec.serverDenyList.includes(declaration.name)) {
          notes.push(`${declaration.origin}: server "${declaration.name}" skipped: listed in serverDenyList`)
          continue
        }
        if (mounts.length >= spec.maxServers) {
          notes.push(`${declaration.origin}: server "${declaration.name}" skipped: maxServers (${String(spec.maxServers)}) reached`)
          continue
        }
        mounts.push({ declaration, serverName: allocateServerName(declaration.name, used) })
      }
    }
  }
  for (const note of notes) ctx.logger.warn(`agent-import: ${note}`)
  return await mountForeignServers(ctx, mounts, spec.failOnStartupError)
}

/** Read one optional configuration file; absence is normal, any other failure is reported. */
async function readOptionalFile(ctx: Context, path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (!missing) ctx.logger.warn(`agent-import: cannot read "${path}": ${String(error)}`)
    return undefined
  }
}
