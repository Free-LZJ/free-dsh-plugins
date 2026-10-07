/**
 * The agent skill directories this package reads, and imports from.
 *
 * Every agent tool in this ecosystem keeps the same layout — a directory of
 * `<skill>/SKILL.md` bundles — under a tool-specific home directory, in a user
 * scope and often a project scope as well. dsh's own roots (`~/.dsh/skills` and
 * `<project>/.dsh/skills`) are the ones this package writes into; every other
 * root is read-only input, and the tool that owns it keeps working on its own
 * copy.
 *
 * Ranks decide two things. Within one directory, entries are listed in rank
 * order. Across roots, the lowest rank offering a skill name wins, so a skill
 * someone placed in dsh deliberately is never shadowed by an import: every
 * project-scope root outranks every user-scope root (the project is the
 * narrower context), and within each scope dsh's own root comes first.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-roots
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvLookup } from './types.ts'

/** Identifier of one agent whose skill directory this package knows. */
export type SkillSourceId =
  | 'dsh' | 'agents' | 'project' | 'cc-switch' | 'codex' | 'claude-code' | 'gemini' | 'opencode'
  | 'cursor' | 'copilot' | 'windsurf' | 'windsurf-legacy' | 'trae' | 'trae-cn'
  | 'openclaw' | 'clawdbot' | 'roo' | 'codebuddy' | 'workbuddy' | 'qoder' | 'qoder-cn' | 'lingma'

/** Which of the two scopes a root belongs to. */
export type SkillScope = 'user' | 'project'

/** A directory below a home or project directory, with the environment variable that replaces it. */
export interface SkillDirectorySpec {
  /** Path segments appended to the scope directory; empty for the project root itself. */
  readonly segments: readonly string[]
  /** Environment variable holding this directory directly, overriding the home-relative default. */
  readonly env?: string
}

/** One agent's skill directories, in whichever scopes that agent keeps them. */
export interface SkillSourceSpec {
  /** Stable identifier the page and the routes address this source by. */
  readonly id: SkillSourceId
  /** Tool name used where a client shows this source; clients may localize it by id instead. */
  readonly label: string
  /** User-scope directory; absent when the tool has no user scope. */
  readonly user?: SkillDirectorySpec
  /** Project-scope directory; absent when the tool has no project scope. */
  readonly project?: SkillDirectorySpec
  /** User-scope precedence, lower first. */
  readonly rank: number
  /**
   * Whether this package may create and remove entries in this root. Only dsh's
   * own roots are writable: every other tool's directory stays its owner's, so
   * importing never edits what another agent reads.
   */
  readonly writable?: boolean
}

/** First project-scope rank, below every user-scope rank so a project skill wins. */
const PROJECT_RANK_BASE = 100

/**
 * The known agent skill directories, most significant first.
 *
 * A root that does not exist is not an error: an agent that was never installed
 * simply contributes nothing, which is why the readers filter on existence and
 * treat absence as empty rather than as failure.
 */
export const SKILL_SOURCES: readonly SkillSourceSpec[] = [
  { id: 'dsh', label: 'dsh', user: { segments: ['.dsh'], env: 'DSH_HOME' }, project: { segments: ['.dsh'] }, rank: 400, writable: true },
  { id: 'agents', label: 'Agents', user: { segments: ['.agents'], env: 'DSH_AGENTS_HOME' }, project: { segments: ['.agents'] }, rank: 450 },
  { id: 'project', label: 'Project skills', project: { segments: [] }, rank: 470 },
  { id: 'cc-switch', label: 'CC Switch', user: { segments: ['.cc-switch'] }, rank: 500 },
  { id: 'codex', label: 'Codex', user: { segments: ['.codex'], env: 'CODEX_HOME' }, project: { segments: ['.codex'] }, rank: 510 },
  { id: 'claude-code', label: 'Claude Code', user: { segments: ['.claude'], env: 'CLAUDE_CONFIG_DIR' }, project: { segments: ['.claude'] }, rank: 520 },
  { id: 'gemini', label: 'Gemini', user: { segments: ['.gemini'] }, project: { segments: ['.gemini'] }, rank: 530 },
  { id: 'opencode', label: 'OpenCode', user: { segments: ['.config', 'opencode'] }, project: { segments: ['.opencode'] }, rank: 540 },
  { id: 'cursor', label: 'Cursor', user: { segments: ['.cursor'] }, project: { segments: ['.cursor'] }, rank: 550 },
  { id: 'copilot', label: 'Copilot', user: { segments: ['.copilot'] }, project: { segments: ['.github'] }, rank: 560 },
  // Windsurf moved its user directory; the old one is still read when present.
  { id: 'windsurf', label: 'Windsurf', user: { segments: ['.codeium', 'windsurf'] }, project: { segments: ['.windsurf'] }, rank: 570 },
  { id: 'windsurf-legacy', label: 'Windsurf (legacy)', user: { segments: ['.windsurf'] }, rank: 571 },
  { id: 'trae', label: 'Trae', user: { segments: ['.trae'] }, project: { segments: ['.trae'] }, rank: 580 },
  { id: 'trae-cn', label: 'Trae CN', user: { segments: ['.trae-cn'] }, project: { segments: ['.trae-cn'] }, rank: 590 },
  { id: 'openclaw', label: 'OpenClaw', user: { segments: ['.openclaw'] }, rank: 600 },
  { id: 'clawdbot', label: 'Clawdbot', user: { segments: ['.clawdbot'] }, rank: 601 },
  { id: 'roo', label: 'Roo', user: { segments: ['.roo'] }, project: { segments: ['.roo'] }, rank: 610 },
  { id: 'codebuddy', label: 'CodeBuddy', user: { segments: ['.codebuddy'] }, project: { segments: ['.codebuddy'] }, rank: 620 },
  { id: 'workbuddy', label: 'WorkBuddy', user: { segments: ['.workbuddy'] }, project: { segments: ['.workbuddy'] }, rank: 630 },
  { id: 'qoder', label: 'Qoder', user: { segments: ['.qoder'] }, project: { segments: ['.qoder'] }, rank: 640 },
  { id: 'qoder-cn', label: 'Qoder CN', user: { segments: ['.qoder-cn'] }, rank: 650 },
  { id: 'lingma', label: 'Lingma', user: { segments: ['.lingma'] }, project: { segments: ['.lingma'] }, rank: 660 },
]

/** One skill directory to read, already resolved against a home and a project. */
export interface ResolvedSkillRoot {
  /** Agent this directory belongs to. */
  readonly source: SkillSourceId
  /** Tool name used where a client shows this source. */
  readonly label: string
  /** Scope this directory covers. */
  readonly scope: SkillScope
  /** Absolute path of the directory holding `<skill>/SKILL.md` bundles. */
  readonly path: string
  /** Precedence, lower first. */
  readonly rank: number
  /** Whether this package may create and remove entries here. */
  readonly writable: boolean
}

/** Where a resolution reads the environment and the scope directories from. */
export interface SkillRootOptions {
  /** User home directory; defaults to the running user's. */
  readonly home?: string
  /** Project root whose project-scope roots are read; omitted skips that scope entirely. */
  readonly projectRoot?: string
  /** Environment holding the per-tool directory overrides. */
  readonly env?: EnvLookup
  /**
   * Sources to resolve; omitted resolves every known source. The writable dsh
   * roots are always resolved, because they hold what is already installed
   * regardless of which sources an import is enabled for.
   */
  readonly sources?: readonly SkillSourceId[]
}

/**
 * Resolve every known skill directory against a home, a project, and an environment.
 * @param options - the directories and environment to resolve against.
 * @returns one entry per root this configuration names, in precedence order.
 */
export function resolveSkillRoots(options: SkillRootOptions = {}): readonly ResolvedSkillRoot[] {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const roots: ResolvedSkillRoot[] = []
  SKILL_SOURCES.forEach((spec, index) => {
    // A disabled source contributes no candidates, but the writable dsh roots
    // are always resolved: they hold what is already installed either way.
    if (options.sources !== undefined && spec.writable !== true && !options.sources.includes(spec.id)) return
    if (spec.user !== undefined) roots.push(userRoot(spec, spec.user, home, env))
    if (spec.project !== undefined && options.projectRoot !== undefined) {
      roots.push({
        source: spec.id,
        label: spec.label,
        scope: 'project',
        path: join(options.projectRoot, ...spec.project.segments, 'skills'),
        rank: PROJECT_RANK_BASE + index,
        writable: spec.writable === true,
      })
    }
  })
  return roots.sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
}

/** Resolve one user-scope directory, honouring the tool's environment override. */
function userRoot(spec: SkillSourceSpec, directory: SkillDirectorySpec, home: string, env: EnvLookup): ResolvedSkillRoot {
  const override = directory.env === undefined ? undefined : env[directory.env]
  const base = override === undefined || override.trim().length === 0 ? join(home, ...directory.segments) : override.trim()
  return {
    source: spec.id,
    label: spec.label,
    scope: 'user',
    path: join(base, 'skills'),
    rank: spec.rank,
    writable: spec.writable === true,
  }
}

/**
 * Pick the root that owns a skill name offered by several roots.
 * @param candidates - the roots offering that name.
 * @returns the winning root, or undefined when none was offered.
 */
export function selectSkillSource(candidates: readonly ResolvedSkillRoot[]): ResolvedSkillRoot | undefined {
  let winner: ResolvedSkillRoot | undefined
  for (const candidate of candidates) {
    if (winner === undefined || candidate.rank < winner.rank) winner = candidate
  }
  return winner
}
