/**
 * The decisions the user made about individual imports, kept across restarts.
 *
 * Importing is automatic and idempotent, so without a note somewhere an import
 * the user removed would be back on the next activation, and the removal would
 * look like it had been ignored. This file is that note. It holds names only —
 * the skills themselves still live in the tool that owns them — and a name
 * leaves it the moment the user imports that skill again, so the file never
 * becomes a second, drifting copy of what is installed.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Directory this plugin keeps its own bookkeeping in, beside dsh's skills. */
const STATE_DIRECTORY = 'agent-import'

/** File the remembered decisions live in. */
const STATE_FILE = 'state.json'

/** What the user decided about imports this package would otherwise repeat. */
export interface SkillState {
  /** Skill names the user removed and does not want imported by itself again. */
  readonly removed: readonly string[]
}

/** The state of a dsh home nothing has been decided in yet. */
export const EMPTY_SKILL_STATE: SkillState = { removed: [] }

/**
 * Where one dsh home remembers the user's import decisions.
 * @param dshHome - dsh's own home, the parent of its writable skill root.
 * @returns the absolute path of the state file.
 */
export function skillStatePath(dshHome: string): string {
  return join(dshHome, STATE_DIRECTORY, STATE_FILE)
}

/**
 * Read the remembered decisions.
 *
 * Anything unreadable or unusable is the empty state: this file is a
 * convenience, and a missing or damaged one must not stop the plugin from
 * importing. Everything the file cannot vouch for is dropped rather than
 * guessed at, so a hand-edited file cannot block a name it does not name.
 * @param path - the state file to read.
 * @returns the decisions it holds, or the empty state.
 */
export async function readSkillState(path: string): Promise<SkillState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return EMPTY_SKILL_STATE
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_SKILL_STATE
    const removed = (parsed as { removed?: unknown }).removed
    if (!Array.isArray(removed)) return EMPTY_SKILL_STATE
    return { removed: removed.filter((name): name is string => typeof name === 'string') }
  } catch {
    return EMPTY_SKILL_STATE
  }
}

/**
 * Apply one decision, returning the state it produced.
 * @param state - the state to change.
 * @param name - the skill the decision is about.
 * @param removed - true when the user removed it, false when they imported it.
 * @returns the state after the decision, with names kept sorted.
 */
export function withDecision(state: SkillState, name: string, removed: boolean): SkillState {
  const names = new Set(state.removed)
  if (removed) names.add(name)
  else names.delete(name)
  return { removed: [...names].sort() }
}

/**
 * Write the decisions in one step.
 *
 * The file is written beside its destination and renamed onto it, so a reader
 * never sees half a file and an interrupted write leaves the previous one.
 * @param path - the state file to write.
 * @param state - the decisions to remember.
 */
export async function writeSkillState(path: string, state: SkillState): Promise<void> {
  const temporary = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
