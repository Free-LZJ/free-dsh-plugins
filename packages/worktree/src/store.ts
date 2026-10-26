/**
 * The plugin's settings file: two values, on disk, next to the harness home.
 *
 * A profile's Loader row would be the other place, but editing it means editing
 * a user's composition document — and these two values are this plugin's own
 * business, not composition. A small JSON file keeps the write inside the
 * plugin's own directory and survives a reinstall.
 *
 * @module @free-dsh/worktree/store
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { WorktreeSettings } from './protocol.ts'

/** Where the harness keeps per-user state; re-read per call so a test can aim it elsewhere. */
function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The settings document. */
export function settingsFile(): string {
  return join(harnessHome(), 'worktree', 'settings.json')
}

/** Defaults: checkouts inside the repository, upstream fetched first. */
export const DEFAULT_SETTINGS: WorktreeSettings = { parent: '', fetchBeforeCreate: true }

/**
 * Read the settings, falling back to the defaults for anything unusable.
 *
 * A hand-edited or half-written file must not disable the plugin: unknown shapes
 * are simply ignored, which is why every field is validated instead of trusted.
 * @returns the effective settings.
 */
export async function readSettings(): Promise<WorktreeSettings> {
  let raw: string
  try {
    raw = await readFile(settingsFile(), 'utf8')
  } catch {
    return DEFAULT_SETTINGS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SETTINGS
  }
  const body = (parsed ?? {}) as Record<string, unknown>
  return {
    parent: typeof body.parent === 'string' && isAbsolute(body.parent) ? body.parent : '',
    fetchBeforeCreate: typeof body.fetchBeforeCreate === 'boolean'
      ? body.fetchBeforeCreate
      : DEFAULT_SETTINGS.fetchBeforeCreate,
  }
}

/**
 * Validate and persist one settings write, keeping the untouched fields.
 * @param patch - the fields the page changed.
 * @returns the settings now in effect.
 */
export async function writeSettings(patch: { parent?: string; fetchBeforeCreate?: boolean }): Promise<WorktreeSettings> {
  const current = await readSettings()
  const parent = patch.parent === undefined ? current.parent : patch.parent.trim()
  if (parent !== '' && !isAbsolute(parent)) {
    throw new Error('工作树目录必须是绝对路径，或留空使用默认位置')
  }
  const next: WorktreeSettings = {
    parent: parent === '' ? '' : parent,
    fetchBeforeCreate: patch.fetchBeforeCreate ?? current.fetchBeforeCreate,
  }
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
