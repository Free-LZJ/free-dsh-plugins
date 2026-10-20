/**
 * The one user preference this package keeps: which panels are pinned.
 *
 * Written as a tiny JSON document below `$DSH_HOME`, for the same reason the
 * mail package keeps its own state file: a whole storage domain would buy a
 * schema and a lifecycle the workbench does not need for one string array.
 * A read that fails falls back to empty rather than keeping the workbench from
 * starting, and a write goes through a temporary file and a rename so a crash
 * mid-write cannot leave half a document behind.
 *
 * @module @free-lzj/dsh-console/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The directory below `$DSH_HOME` these files live in. */
export const STATE_DIR = 'dsh-console'

/** The preferences document this module owns. */
export interface ConsolePrefs {
  /** Panel ids the user pinned, in the order they were pinned. */
  pinned: string[]
}

/** An empty document: what a missing or unreadable file resolves to. */
export function emptyPrefs(): ConsolePrefs {
  return { pinned: [] }
}

/**
 * Read the preferences document.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @returns the saved document, or an empty one when it is missing or malformed.
 */
export async function readPrefs(home: string): Promise<ConsolePrefs> {
  let text: string
  try {
    text = await readFile(join(home, STATE_DIR, 'prefs.json'), 'utf8')
  } catch {
    return emptyPrefs()
  }
  try {
    return normalize(JSON.parse(text) as unknown)
  } catch {
    return emptyPrefs()
  }
}

/**
 * Replace the preferences document.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @param prefs - the document to persist.
 */
export async function writePrefs(home: string, prefs: ConsolePrefs): Promise<void> {
  const directory = join(home, STATE_DIR)
  const target = join(directory, 'prefs.json')
  const temporary = `${target}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

/**
 * Keep only the string array, dropping anything a hand-edited file put in.
 * @param value - the parsed document.
 * @returns the document this module can trust.
 */
function normalize(value: unknown): ConsolePrefs {
  const candidate = ((value ?? {}) as Record<string, unknown>).pinned
  return {
    pinned: Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string')
      : [],
  }
}
