/**
 * The user preferences this package keeps: the pinned panel list and the view
 * the workbench was last showing.
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
import { CONSOLE_VIEWS, type ConsoleView } from './protocol.ts'

/** The directory below `$DSH_HOME` these files live in. */
export const STATE_DIR = 'dsh-console'

/** The preferences document this module owns. */
export interface ConsolePrefs {
  /** Panel ids the user pinned, in the order they were pinned. */
  pinned: string[]
  /**
   * The view the workbench was last showing.
   *
   * Absent until the user first navigates; the reader falls back to the default
   * view, so an older document (and a fresh profile) both stay valid.
   */
  currentView?: ConsoleView
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
 * Whether a hand-edited value names a view this build knows.
 *
 * A view id from a newer version is dropped rather than trusted: the reader has
 * no page to show for it, and the default view is the only safe answer.
 * @param value - the candidate.
 * @returns true when it is one of {@link CONSOLE_VIEWS}.
 */
export function isConsoleView(value: unknown): value is ConsoleView {
  return typeof value === 'string' && CONSOLE_VIEWS.includes(value as ConsoleView)
}

/**
 * Keep only the fields this module can trust, dropping anything a hand-edited
 * file put in.
 * @param value - the parsed document.
 * @returns the document this module can trust.
 */
function normalize(value: unknown): ConsolePrefs {
  const document = (value ?? {}) as Record<string, unknown>
  const candidate = document.pinned
  return {
    pinned: Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string')
      : [],
    ...(isConsoleView(document.currentView) ? { currentView: document.currentView } : {}),
  }
}
