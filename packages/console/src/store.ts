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
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CONSOLE_VIEWS, type ConsoleLogEntry, type ConsoleNoticeRecord, type ConsoleView } from './protocol.ts'

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
  await writeJson(home, 'prefs.json', prefs)
}

/**
 * The records the workbench accumulates: the attention queue and the automation log.
 *
 * Both are what the user reads *after* the fact — "what was waiting for me", "what
 * did it do while I was away" — so losing them on a restart turns the workbench
 * into a page that only ever shows the last few minutes. They live in one file
 * because one write keeps them consistent: a notice and the log line about it
 * belong to the same moment.
 */
export interface ConsoleRecords {
  readonly notices: readonly ConsoleNoticeRecord[]
  readonly log: readonly ConsoleLogEntry[]
}

/** An empty record document: what a missing or unreadable file resolves to. */
export function emptyRecords(): ConsoleRecords {
  return { notices: [], log: [] }
}

/**
 * Read the record document.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @returns the saved records, or an empty document when it is missing or malformed.
 */
export async function readRecords(home: string): Promise<ConsoleRecords> {
  let text: string
  try {
    text = await readFile(join(home, STATE_DIR, 'records.json'), 'utf8')
  } catch {
    return emptyRecords()
  }
  try {
    const document = (JSON.parse(text) as unknown ?? {}) as Record<string, unknown>
    return {
      notices: entries<ConsoleNoticeRecord>(document.notices, isRecordShape),
      log: entries<ConsoleLogEntry>(document.log, isLogShape),
    }
  } catch {
    return emptyRecords()
  }
}

/**
 * Replace the record document.
 *
 * The temporary name carries a uuid, not just the pid: a busy mailbox raises a
 * notice while a log line is being written, and two writers sharing one temp
 * name means the loser's rename fails and its snapshot is lost.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @param records - the document to persist.
 */
export async function writeRecords(home: string, records: ConsoleRecords): Promise<void> {
  await writeJson(home, 'records.json', records)
}

/**
 * Write one JSON document below {@link STATE_DIR}.
 * @param home - the harness home directory.
 * @param name - the file name inside the directory.
 * @param value - what to serialize.
 */
async function writeJson(home: string, name: string, value: unknown): Promise<void> {
  const directory = join(home, STATE_DIR)
  const target = join(directory, name)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

/**
 * Keep the array elements this build can render.
 *
 * Only the identity fields are checked: everything else was written by this
 * module, and a strict schema here would silently drop a record whose shape grew
 * in a newer build instead of showing what it can.
 * @param value - the parsed array.
 * @param accept - whether one element is usable.
 * @returns the usable elements, or an empty array.
 */
function entries<T>(value: unknown, accept: (item: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is T => typeof item === 'object' && item !== null && accept(item as Record<string, unknown>))
}

/** A record needs an id and a title to be drawn. */
function isRecordShape(item: Record<string, unknown>): boolean {
  return typeof item['id'] === 'string' && typeof item['title'] === 'string'
}

/** A log line needs an id and a title to be drawn. */
function isLogShape(item: Record<string, unknown>): boolean {
  return isRecordShape(item)
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
