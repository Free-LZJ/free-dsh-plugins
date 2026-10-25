/**
 * The board's persisted document.
 *
 * Same shape as the workbench's own preferences (`../store.ts`): one small
 * JSON document below `$DSH_HOME`, written through a temporary file and a
 * rename so a crash mid-write cannot leave half a document, read tolerantly
 * so a missing or malformed file resolves to an empty board rather than
 * keeping the workbench from starting. Sessions restore through
 * {@link ./sessions.ts SessionStore.restore}, which downgrades `running` to
 * `paused` — a handle that died with the last process is not a running run.
 *
 * @module @free-lzj/dsh-console/workbench/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbenchCard, WorkbenchSession } from '../protocol.ts'
import { STATE_DIR } from '../store.ts'

/** The persisted board document. */
export interface WorkbenchDocument {
  readonly version: number
  readonly cards: readonly WorkbenchCard[]
  readonly sessions: readonly WorkbenchSession[]
}

/** An empty document: what a missing or unreadable file resolves to. */
export function emptyDocument(): WorkbenchDocument {
  return { version: 1, cards: [], sessions: [] }
}

/**
 * Read the board document.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @returns the saved document, or an empty one when it is missing or malformed.
 */
export async function readWorkbench(home: string): Promise<WorkbenchDocument> {
  let text: string
  try {
    text = await readFile(join(home, STATE_DIR, 'workbench.json'), 'utf8')
  } catch {
    return emptyDocument()
  }
  try {
    return normalize(JSON.parse(text) as unknown)
  } catch {
    return emptyDocument()
  }
}

/**
 * Replace the board document.
 *
 * The temporary name carries a uuid, not just the pid: the board bumps on
 * every log line, so several writes are routinely in flight at once, and a
 * pid-only name lets one rename steal the file another write just made —
 * the loser then fails with ENOENT and its snapshot is lost.
 * @param home - the harness home directory (`$DSH_HOME`).
 * @param document - the document to persist.
 */
export async function writeWorkbench(home: string, document: WorkbenchDocument): Promise<void> {
  const directory = join(home, STATE_DIR)
  const target = join(directory, 'workbench.json')
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

/**
 * Keep only the arrays, dropping anything a hand-edited file put in.
 * @param value - the parsed document.
 * @returns the document this module can trust.
 */
function normalize(value: unknown): WorkbenchDocument {
  const candidate = (value ?? {}) as Record<string, unknown>
  return {
    version: 1,
    cards: Array.isArray(candidate.cards)
      ? (candidate.cards as WorkbenchCard[]).filter((card) => typeof card?.id === 'string')
      : [],
    sessions: Array.isArray(candidate.sessions)
      ? (candidate.sessions as WorkbenchSession[]).filter((session) => typeof session?.id === 'string')
      : [],
  }
}
