/**
 * Import the MCP servers another agent tool already has, and manage the skills
 * every agent tool keeps.
 *
 * dsh normally reaches MCP servers through its own configuration. A user who
 * also runs Codex or Claude Code has already declared them, so this plugin
 * selects the adapters named by `sources` and mounts every server they declare
 * through `@deepseek-ai/dsh-mcp-client`. Declarations that cannot be translated
 * are reported as warnings rather than failing activation, so one unusable
 * third-party entry never costs the user the rest of their imported tools.
 *
 * Skills work differently: instead of republishing another tool's directory,
 * this plugin links each skill into dsh's own root — `~/.dsh/skills/<name>`, a
 * junction on Windows, which needs neither Administrator nor Developer Mode —
 * where dsh's filesystem skill provider reads it as a local skill. Nothing is
 * copied, so an edit in the owning tool is immediately the edit dsh reads, and
 * removing an import removes only the link. `skillSources` selects the
 * directories to read, and the settings page imports, removes, and inspects one
 * skill at a time through the routes registered below.
 *
 * Every field is a volatile config reference, so a settings card can change one
 * without a restart: each change unmounts the previous import generation and
 * builds the next from a single snapshot of the new values. Automatic import
 * runs at activation and whenever the enabled source set changes, so a skill
 * the user removed is not imported again by an unrelated configuration edit.
 *
 * The plugin also publishes what each generation produced on the report route,
 * so the card can show the user which servers and skills are actually loaded
 * rather than only what was asked for.
 *
 * @module @deepseek-ai/dsh-agent-import
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event merge this plugin subscribes to.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the `ctx.webServer` service merge the settings routes register on.
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
import { buildSkillCatalog } from './skill-catalog.ts'
import type { SkillCatalog } from './skill-catalog.ts'
import { importSkill, removeSkill, skillStatePathFor, syncSkills } from './skill-import.ts'
import type { SkillImportOptions, SkillImportOutcome, SkillImportRequest } from './skill-import.ts'
import { resolveSkillRoots } from './skill-roots.ts'
import type { ResolvedSkillRoot, SkillSourceId } from './skill-roots.ts'
import {
  createSkillContentHandler,
  createSkillMutationHandler,
  createSkillsHandler,
  SKILL_CONTENT_PATH,
  SKILL_IMPORT_PATH,
  SKILL_REMOVE_PATH,
  SKILLS_PATH,
} from './skill-routes.ts'
import type { SkillRouteOperations } from './skill-routes.ts'
import type { ForeignMcpServer, ForeignSource } from './types.ts'

/** Plugin name registered under the Cordis loader. */
export const name = 'agent-import'

/** Adapters every installation reads unless `sources` narrows them. */
const SOURCES: readonly ForeignSource[] = ['codex', 'claude-code']

/**
 * Skill directories whose skills are imported by themselves when the plugin activates.
 *
 * This is the *automatic* half of the skill configuration, not the readable one:
 * every known source is read either way, because the page has to show what could
 * be imported from anywhere. Only these two are linked without being asked, so
 * that enabling this plugin never floods a dsh home with other tools' skills.
 */
const SKILL_SOURCES_DEFAULT: readonly SkillSourceId[] = ['codex', 'claude-code']

/** Builds the adapter of one supported tool from one import configuration. */
const ADAPTERS: Readonly<Record<ForeignSource, (config: ImportSpec) => ForeignAgentAdapter>> = {
  codex: config => codexAdapter(config.codex),
  'claude-code': config => claudeCodeAdapter(config.claudeCode),
}

/** Upper bound on mounted servers when the configuration sets none. */
const DEFAULT_MAX_SERVERS = 64

/** Upper bound on skills one catalog build reads when the configuration sets none. */
const DEFAULT_MAX_SKILLS = 200

/** Other agent tools to import from, as live references the settings card can edit. */
export interface Config {
  /** Tools whose MCP servers are read, in precedence order. */
  sources: Volatile<ForeignSource[]>
  /** Codex import options, resolved from their own defaults. */
  codex: Volatile<CodexOptions>
  /** Claude Code import options, resolved from their own defaults. */
  claudeCode: Volatile<ClaudeCodeOptions>
  /** Workspace whose project-local configuration is read; an empty value means the process working directory. */
  projectRoot: Volatile<string>
  /** Whether the imported MCP servers are mounted. */
  mcp: Volatile<boolean>
  /** Whether skills are imported and managed at all. */
  skills: Volatile<boolean>
  /** Agent skill directories to read and import from. */
  skillSources: Volatile<SkillSourceId[]>
  /** Whether the enabled skill sources are imported as links when the plugin activates. */
  skillAutoImport: Volatile<boolean>
  /** Foreign server names to leave unmounted, matched against the declaring tool's own name. */
  serverDenyList: Volatile<string[]>
  /** Maximum imported MCP servers to mount. */
  maxServers: Volatile<number>
  /** Maximum skills one catalog build reads. */
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
  skillSources?: SkillSourceId[]
  skillAutoImport?: boolean
  serverDenyList?: string[]
  maxServers?: number
  maxSkills?: number
  failOnStartupError?: boolean
}

/**
 * One agent skill directory the configuration may name.
 *
 * Written out rather than derived from the table, because a schema is static
 * while the table is data: a source added to the table without a line here is
 * rejected by configuration validation instead of silently ignored.
 */
const SkillSourceSchema = z.union([
  z.const('dsh'), z.const('agents'), z.const('project'), z.const('cc-switch'), z.const('codex'),
  z.const('claude-code'), z.const('gemini'), z.const('opencode'), z.const('cursor'), z.const('copilot'),
  z.const('windsurf'), z.const('windsurf-legacy'), z.const('trae'), z.const('trae-cn'),
  z.const('openclaw'), z.const('clawdbot'), z.const('roo'), z.const('codebuddy'), z.const('workbuddy'),
  z.const('qoder'), z.const('qoder-cn'), z.const('lingma'),
])

export const Config = z.object({
  sources: z.array(z.union([z.const('codex'), z.const('claude-code')])).default([...SOURCES]).volatile(),
  codex: CodexOptionsSchema.default({}).volatile(),
  claudeCode: ClaudeCodeOptionsSchema.default({}).volatile(),
  projectRoot: z.string().default('').volatile(),
  mcp: z.boolean().default(true).volatile(),
  skills: z.boolean().default(true).volatile(),
  skillSources: z.array(SkillSourceSchema).default([...SKILL_SOURCES_DEFAULT]).volatile(),
  skillAutoImport: z.boolean().default(true).volatile(),
  serverDenyList: z.array(z.string()).default([]).volatile(),
  maxServers: z.number().default(DEFAULT_MAX_SERVERS).volatile(),
  maxSkills: z.number().default(DEFAULT_MAX_SKILLS).volatile(),
  failOnStartupError: z.boolean().default(false).volatile(),
}) as z<ConfigInput, Config>

/** Import options captured from the live configuration for one import generation. */
interface ImportSpec {
  /** Tools whose MCP servers are read, in precedence order. */
  readonly sources: readonly ForeignSource[]
  /** Codex import options. */
  readonly codex: CodexOptions
  /** Claude Code import options. */
  readonly claudeCode: ClaudeCodeOptions
  /** Workspace whose project-local configuration is read. */
  readonly projectRoot: string
  /** Whether the imported MCP servers are mounted. */
  readonly mcp: boolean
  /** Whether skills are imported and managed at all. */
  readonly skills: boolean
  /** Agent skill directories to read and import from. */
  readonly skillSources: readonly SkillSourceId[]
  /** Whether the enabled skill sources are imported as links when the plugin activates. */
  readonly skillAutoImport: boolean
  /** Foreign server names to leave unmounted. */
  readonly serverDenyList: readonly string[]
  /** Maximum imported MCP servers to mount. */
  readonly maxServers: number
  /** Maximum skills one catalog build reads. */
  readonly maxSkills: number
  /** Whether one server failing to start rejects plugin activation. */
  readonly failOnStartupError: boolean
}

/** One import generation: the mounted servers, and the skill roots it reads. */
interface ImportGeneration {
  /** Mounted server children, in declaration order. */
  readonly servers: readonly Fiber[]
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
  /** Whether the skill manager is enabled for this generation. */
  readonly skills: boolean
  /** Roots the skill manager reads and imports into; empty when it is disabled. */
  readonly skillRoots: readonly ResolvedSkillRoot[]
  /** Upper bound on skills one catalog build reads. */
  readonly maxSkills: number
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

/**
 * Mount the configured MCP servers and import the configured skills, then keep
 * both in step with later configuration edits, and answer the settings routes
 * with what the current generation imported.
 * @param ctx - plugin context; mounted servers become children of its fiber.
 * @param config - live import configuration selecting the adapters and their bounds.
 * @returns readiness after the first generation settles; later generations follow configuration changes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const initial = snapshot(config)
  let generation: ImportGeneration | undefined = await buildGeneration(ctx, initial, true)
  let record: GenerationRecord | undefined = generation.record
  let synced = syncKey(initial)
  let pending: Promise<void> = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    pending = pending.then(async () => {
      try {
        await disposeGeneration(generation)
        generation = undefined
        // A generation that failed to build leaves nothing to report, so the
        // route stops describing the one just unmounted.
        record = undefined
        const spec = snapshot(config)
        const key = syncKey(spec)
        generation = await buildGeneration(ctx, spec, key !== synced)
        synced = key
        record = generation.record
      } catch (error: unknown) {
        ctx.logger.error(`agent-import: re-import after a configuration change failed: ${String(error)}`)
      }
    })
  })
  ctx.inject(['webServer'], (inner) => {
    const operations: SkillRouteOperations = {
      catalog: async () => readCatalog(record),
      importSkill: async (request: SkillImportRequest) => await runSkillOperation(record, async (roots, options) => await importSkill(roots, options, request)),
      removeSkill: async (skillName: string) => await runSkillOperation(record, async (roots, options) => await removeSkill(roots, options, skillName)),
    }
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: REPORT_PATH,
      handler: createReportHandler(() => readReport(record)),
    }), 'agent-import.report-route')
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: SKILLS_PATH,
      handler: createSkillsHandler(operations),
    }), 'agent-import.skills-route')
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: SKILL_CONTENT_PATH,
      handler: createSkillContentHandler(operations),
    }), 'agent-import.skill-content-route')
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: SKILL_IMPORT_PATH,
      handler: createSkillMutationHandler(operations, 'import'),
    }), 'agent-import.skill-import-route')
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: SKILL_REMOVE_PATH,
      handler: createSkillMutationHandler(operations, 'remove'),
    }), 'agent-import.skill-remove-route')
  })
}

/**
 * Read the current import report.
 *
 * The skill list is what dsh's own root now holds — the imports this plugin
 * made and any skill placed there by hand — because that, and not the foreign
 * directories, is what dsh actually loads.
 * @param record - the active generation's facts, or `undefined` while none is.
 * @returns the report the settings card renders.
 */
async function readReport(record: GenerationRecord | undefined): Promise<AgentImportReport> {
  if (record === undefined) return NO_REPORT
  const catalog = await readCatalog(record)
  const installed = catalog.skills.filter(skill => skill.state === 'linked' || skill.state === 'local')
  return {
    importedAt: record.importedAt,
    sources: [...record.sources],
    skills: installed.map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.installedSource ?? skill.candidates.find(candidate => candidate.winner)?.source ?? 'dsh',
      path: skill.installedFile ?? skill.installedPath ?? '',
    })),
    servers: [...record.servers],
    notes: [...record.notes, ...catalog.notes],
  }
}

/** Build the catalog the skills page reads, honouring the `skills` switch. */
async function readCatalog(record: GenerationRecord | undefined): Promise<SkillCatalog> {
  if (record === undefined) return { skills: [], notes: [] }
  if (!record.skills) return { skills: [], notes: ['skill management is disabled by the skills setting'] }
  // The same options the mutations run with, so a name the user removed reads as
  // removed here too rather than looking like one that was never imported.
  return await buildSkillCatalog(record.skillRoots, skillOptions(record.skillRoots, record.maxSkills))
}

/** Run one skill mutation against the live generation, refusing while skills are disabled. */
async function runSkillOperation(
  record: GenerationRecord | undefined,
  operation: (roots: readonly ResolvedSkillRoot[], options: SkillImportOptions) => Promise<SkillImportOutcome>,
): Promise<SkillImportOutcome> {
  if (record === undefined || !record.skills) {
    return { imported: [], removed: [], skipped: [], notes: ['skill management is disabled'] }
  }
  return await operation(record.skillRoots, skillOptions(record.skillRoots, record.maxSkills))
}

/** The options every skill operation of one generation runs with. */
function skillOptions(roots: readonly ResolvedSkillRoot[], maxSkills: number): SkillImportOptions {
  const statePath = skillStatePathFor(roots)
  return statePath === undefined ? { maxSkills } : { maxSkills, statePath }
}

/** The key that decides whether a configuration change should import again. */
function syncKey(spec: ImportSpec): string {
  if (!spec.skills || !spec.skillAutoImport) return ''
  return [...new Set(spec.skillSources)].sort().join(',')
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
    skillSources: config.skillSources.get(),
    skillAutoImport: config.skillAutoImport.get(),
    serverDenyList: config.serverDenyList.get(),
    maxServers: config.maxServers.get(),
    maxSkills: config.maxSkills.get(),
    failOnStartupError: config.failOnStartupError.get(),
  }
}

/**
 * Mount servers and import skills for one snapshot, rolling back a partial result.
 * @param ctx - plugin context owning the mounted children.
 * @param spec - the options this generation was built from.
 * @param importSkills - whether to import skills now; false keeps the existing links untouched.
 */
async function buildGeneration(ctx: Context, spec: ImportSpec, importSkills: boolean): Promise<ImportGeneration> {
  const adapters = selectAdapters(spec)
  const context = adapterContext(ctx, spec)
  let servers: readonly Fiber[] = []
  let serverReports: readonly ImportedServerReport[] = []
  const notes: string[] = []
  try {
    if (spec.mcp) {
      const mounted = await mountServers(ctx, spec, adapters, context)
      servers = mounted.fibers
      serverReports = mounted.servers
      notes.push(...mounted.notes)
    }
    const skillRoots = spec.skills ? readSkillRoots(spec, context) : []
    if (spec.skills && spec.skillAutoImport && importSkills) {
      const enabled = autoImportRoots(skillRoots, spec)
      if (enabled.length > 0) {
        notes.push(...syncNotes(await syncSkills(enabled, skillOptions(enabled, spec.maxSkills))))
      }
    }
    return {
      servers,
      record: {
        importedAt: new Date().toISOString(),
        sources: adapters.map(adapter => adapter.source),
        servers: serverReports,
        notes,
        skills: spec.skills,
        skillRoots,
        maxSkills: spec.maxSkills,
      },
    }
  } catch (error: unknown) {
    await disposeGeneration({ servers })
    throw error
  }
}

/** Remove one import generation: every mounted server child. */
async function disposeGeneration(generation: Pick<ImportGeneration, 'servers'> | undefined): Promise<void> {
  if (generation === undefined) return
  for (const fiber of generation.servers) await fiber.dispose()
}

/**
 * The skill roots one generation reads.
 *
 * Every source this package knows is read, not only the ones the user enabled:
 * the page's job is to show what could be imported from anywhere, and a skill it
 * cannot see is a skill it cannot offer. Reading is read-only and costs nothing
 * outside this plugin — dsh loads the skills in its own directory, not these —
 * while {@link autoImportRoots} narrows down what is written without being asked.
 *
 * The explicit path options are folded into the environment, because an option
 * and the variable it defaults to are the same fact: a user who pointed
 * `codex.home` at a directory must not have skills read from the default one.
 * @param spec - the generation's options.
 * @param context - the resolved workspace and the process environment.
 * @returns every root to read, in precedence order.
 */
function readSkillRoots(spec: ImportSpec, context: AdapterContext): readonly ResolvedSkillRoot[] {
  const env: Record<string, string | undefined> = { ...context.env }
  if (spec.codex.home) env['CODEX_HOME'] = spec.codex.home
  if (spec.claudeCode.configDir) env['CLAUDE_CONFIG_DIR'] = spec.claudeCode.configDir
  const roots = [...resolveSkillRoots({ projectRoot: context.projectRoot, env })]
  if (spec.codex.includeSystemSkills) {
    // Codex's own bundled skills sit in a dot directory the scan skips, so the
    // option that asks for them has to name that directory itself.
    const codex = roots.find(root => root.source === 'codex' && root.scope === 'user')
    if (codex !== undefined) roots.push({ ...codex, label: `${codex.label} bundled`, path: join(codex.path, '.system') })
  }
  return roots
}

/**
 * The roots automatic import may take skills from.
 *
 * A source the user did not enable is still listed and its skills can still be
 * imported one at a time; what it does not get is an import nobody asked for.
 * The writable roots stay in either way, because they are where imports land and
 * where what is already installed is read from.
 * @param roots - every root this generation reads.
 * @param spec - the generation's options, carrying the enabled sources.
 * @returns the roots automatic import may write from.
 */
function autoImportRoots(roots: readonly ResolvedSkillRoot[], spec: ImportSpec): readonly ResolvedSkillRoot[] {
  return roots.filter(root => root.writable || spec.skillSources.includes(root.source))
}

/** Turn one synchronization outcome into the report lines it deserves. */function syncNotes(outcome: SkillImportOutcome): readonly string[] {
  const lines: string[] = []
  if (outcome.imported.length > 0) lines.push(`imported ${outcome.imported.length} skill(s): ${outcome.imported.join(', ')}`)
  for (const skip of outcome.skipped) {
    // A skill that was already imported, or that the user removed on purpose, is
    // the steady state on every reload, so it is left out of the report lines.
    if (skip.reason === 'already-installed' || skip.reason === 'removed') continue
    lines.push(`skill "${skip.name}" left alone: ${skip.reason}${skip.detail === undefined ? '' : ` (${skip.detail})`}`)
  }
  return lines
}

/** Build the adapter of every enabled source, reading a repeated source once. */
function selectAdapters(spec: ImportSpec): ForeignAgentAdapter[] {
  const adapters: ForeignAgentAdapter[] = []
  for (const source of new Set(spec.sources)) adapters.push(ADAPTERS[source](spec))
  return adapters
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
