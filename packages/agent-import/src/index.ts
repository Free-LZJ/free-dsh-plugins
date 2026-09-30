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
 * The plugin also publishes what each generation produced on the report route,
 * so the card can show the user which servers and skills are actually loaded
 * rather than only what was asked for.
 *
 * @module @deepseek-ai/dsh-agent-import
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event merge this plugin subscribes to.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the `ctx.webServer` service merge the report route registers on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { ClaudeCodeOptionsSchema, claudeCodeAdapter } from './adapters/claude-code.ts'
import type { ClaudeCodeOptions } from './adapters/claude-code.ts'
import { CodexOptionsSchema, codexAdapter } from './adapters/codex.ts'
import type { CodexOptions } from './adapters/codex.ts'
import type { AdapterContext, ForeignAgentAdapter } from './adapter.ts'
import { allocateServerName, mountForeignServers } from './mcp.ts'
import type { ServerMount } from './mcp.ts'
import { createReportHandler, NO_REPORT, REPORT_PATH } from './report.ts'
import type { AgentImportReport, ImportedServerReport } from './report.ts'
import { ForeignSkillProvider } from './skills.ts'
import type { ForeignMcpServer, ForeignSkillRoot, ForeignSource } from './types.ts'

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
  /** What the report route answers for this generation. */
  readonly record: GenerationRecord
}

/** One generation's report facts, before its skills are enumerated. */
interface GenerationRecord {
  /** ISO instant this generation was built. */
  readonly importedAt: string
  /** Tools this generation read, in precedence order. */
  readonly sources: readonly ForeignSource[]
  /** Servers this generation planned, in declaration order. */
  readonly servers: readonly ImportedServerReport[]
  /** Declarations and files this generation could not use. */
  readonly notes: readonly string[]
  /** Provider publishing this generation's skills; absent when it publishes none. */
  readonly provider?: ForeignSkillProvider | undefined
}

/** One generation's planned servers: the mounted children, the report rows, and the read's notes. */
interface MountedServers {
  /** Mounted server children, in declaration order. */
  readonly fibers: readonly Fiber[]
  /** One report row per planned server, mounted or skipped. */
  readonly servers: readonly ImportedServerReport[]
  /** Every note the read and the bounds produced. */
  readonly notes: readonly string[]
}

/** One generation's skill publication: the provider the report enumerates, and its registry effect. */
interface PublishedSkills {
  /** The provider whose candidates the report lists. */
  readonly provider: ForeignSkillProvider
  /** Removes the provider from the skill catalog. */
  readonly dispose: () => void
}

/**
 * Mount the configured MCP servers and publish the configured skills, then keep
 * both in step with later configuration edits, and answer the report route with
 * what the current generation imported.
 * @param ctx - plugin context; mounted servers become children of its fiber.
 * @param config - live import configuration selecting the adapters and their bounds.
 * @returns readiness after the first generation settles; later generations follow configuration changes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let generation: ImportGeneration | undefined = await buildGeneration(ctx, snapshot(config))
  let record: GenerationRecord | undefined = generation.record
  let pending: Promise<void> = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    pending = pending.then(async () => {
      try {
        await disposeGeneration(generation)
        generation = undefined
        // A generation that failed to build leaves nothing to report, so the
        // route stops describing the one just unmounted.
        record = undefined
        generation = await buildGeneration(ctx, snapshot(config))
        record = generation.record
      } catch (error: unknown) {
        ctx.logger.error(`agent-import: re-import after a configuration change failed: ${String(error)}`)
      }
    })
  })
  ctx.inject(['webServer'], (inner) => {
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: REPORT_PATH,
      handler: createReportHandler(() => readReport(record)),
    }), 'agent-import.report-route')
  })
}

/**
 * Read the current import report, enumerating the live provider so the skill
 * list follows the directories rather than the activation that registered it.
 * @param record - the active generation's facts, or `undefined` while none is.
 * @returns the report the settings card renders.
 */
async function readReport(record: GenerationRecord | undefined): Promise<AgentImportReport> {
  if (record === undefined) return NO_REPORT
  const candidates = record.provider === undefined ? [] : await record.provider.list({})
  return {
    importedAt: record.importedAt,
    sources: [...record.sources],
    skills: candidates.map(candidate => ({
      name: candidate.name,
      description: candidate.description,
      source: candidate.source,
      path: candidate.path ?? '',
    })),
    servers: [...record.servers],
    notes: [...record.notes],
  }
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
  let serverReports: readonly ImportedServerReport[] = []
  let notes: readonly string[] = []
  let published: PublishedSkills | undefined
  try {
    if (spec.mcp) {
      const mounted = await mountServers(ctx, spec, adapters, context)
      servers = mounted.fibers
      serverReports = mounted.servers
      notes = mounted.notes
    }
    if (spec.skills) published = publishSkills(ctx, spec, adapters, context)
  } catch (error: unknown) {
    await disposeGeneration({ servers, disposeSkills: published?.dispose })
    throw error
  }
  return {
    servers,
    disposeSkills: published?.dispose,
    record: {
      importedAt: new Date().toISOString(),
      sources: adapters.map(adapter => adapter.source),
      servers: serverReports,
      notes,
      provider: published?.provider,
    },
  }
}

/** Remove one import generation: the skill provider first, then every mounted server. */
async function disposeGeneration(generation: Pick<ImportGeneration, 'servers' | 'disposeSkills'> | undefined): Promise<void> {
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
): PublishedSkills | undefined {
  const roots: ForeignSkillRoot[] = []
  for (const adapter of adapters) roots.push(...adapter.skillRoots(context))
  if (roots.length === 0) return undefined
  const provider = new ForeignSkillProvider(ctx, roots, spec.maxSkills)
  return { provider, dispose: ctx.skills.registerProvider(() => provider) }
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
): Promise<MountedServers> {
  const used = new Set<string>()
  const mounts: ServerMount[] = []
  const servers: ImportedServerReport[] = []
  const notes: string[] = []
  for (const adapter of adapters) {
    for (const read of await adapter.readServers(context)) {
      notes.push(...read.notes)
      for (const declaration of read.servers) {
        // The report keeps every decision visible: a server the bounds or the
        // deny list left unmounted is still a declared server the user asked about.
        const skip = skipReason(spec, declaration, mounts.length)
        if (skip !== undefined) {
          notes.push(`${declaration.origin}: server "${declaration.name}" skipped: ${skip}`)
          servers.push({ ...serverRow(declaration), status: 'skipped', reason: skip })
          continue
        }
        const serverName = allocateServerName(declaration.name, used)
        mounts.push({ declaration, serverName })
        servers.push({ ...serverRow(declaration), serverName, status: 'mounted' })
      }
    }
  }
  for (const note of notes) ctx.logger.warn(`agent-import: ${note}`)
  return { fibers: await mountForeignServers(ctx, mounts, spec.failOnStartupError), servers, notes }
}

/**
 * Why one declared server is left unmounted, or `undefined` when it is mounted.
 * @param spec - the generation's bounds and deny list.
 * @param declaration - the server the declaring tool wrote.
 * @param planned - servers already planned for this generation.
 * @returns the reason to skip the server, or `undefined` to mount it.
 */
function skipReason(spec: ImportSpec, declaration: ForeignMcpServer, planned: number): string | undefined {
  if (spec.serverDenyList.includes(declaration.name)) return 'listed in serverDenyList'
  if (planned >= spec.maxServers) return `maxServers (${String(spec.maxServers)}) reached`
  return undefined
}

/** The report row of one declaration, before its mount outcome is known. */
function serverRow(declaration: ForeignMcpServer): Omit<ImportedServerReport, 'status'> {
  return {
    name: declaration.name,
    transport: declaration.transport,
    source: declaration.source,
    target: declaration.transport === 'stdio' ? declaration.command : declaration.url,
  }
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
