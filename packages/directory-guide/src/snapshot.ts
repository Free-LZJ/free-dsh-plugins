/**
 * The read-only walk of the DSH home directory the panel renders.
 *
 * The panel is a browser document, so it can reach no file by itself: the Host
 * half walks the tree here, redacts what it inlines, and hands the panel one
 * JSON payload. Two bounds keep that payload the size of a page rather than the
 * size of a disk — the walk stops two levels below the home directory, and only
 * small text files travel with their bytes at all.
 *
 * @module @free-lzj/dsh-directory-guide/snapshot
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TOP_NOTES, annotate, type Advice, type TopNote } from './notes.ts'

/** One entry the panel lists. */
export interface SnapshotNode {
  /** Entry name. */
  readonly name: string
  /** Whether the entry is a directory. */
  readonly directory: boolean
  /** Byte size for a file, null for a directory. */
  readonly size: number | null
  /** Last-modified time in epoch milliseconds. */
  readonly mtime: number
  /** Hand-written description, when the path matched a known shape. */
  readonly note?: string
  /** Reinstall advice, when the path matched a known shape. */
  readonly advice?: Advice
  /** Why the panel must not inline this file's bytes, when it must not. */
  readonly skip?: string
  /** Children, present only where the walk descended. */
  readonly children?: readonly SnapshotNode[]
}

/** One row of the hand-written top-level table, with the facts read off disk. */
export interface TopNoteRow extends TopNote {
  /** Whether the entry is a directory. */
  readonly directory: boolean
  /** Last-modified time as `YYYY/MM/DD HH:MM`. */
  readonly modified: string
  /** Byte size for a file, null for a directory. */
  readonly size: number | null
}

/** Everything the panel needs, in one payload. */
export interface Snapshot {
  /** When this walk ran, as `YYYY/MM/DD HH:MM`. */
  readonly captured: string
  /** The hand-written rows, in the order the table lists them at the root. */
  readonly items: readonly TopNoteRow[]
  /** The walked tree, root entries first. */
  readonly root: readonly SnapshotNode[]
  /** Inlined text bodies, keyed by slash-joined path below the home directory. */
  readonly blobs: Readonly<Record<string, string>>
}

/** How deep the walk descends: the home directory's own entries are depth 0. */
const MAX_DEPTH = 2
/** Largest file the walk inlines. */
const TEXT_LIMIT = 64 * 1024
/** Most entries one directory contributes before the walk summarizes the rest. */
const MAX_CHILDREN = 400

/**
 * Directories the walk names but does not enter: hundreds of megabytes, or
 * nothing but binaries and vendored packages.
 */
const NO_EXPAND: readonly RegExp[] = [
  /^electron$/,
  /^dsh-runtimes$/,
  /(^|\/)node_modules$/,
  /(^|\/)\.git$/,
  /^attachments\/v1\/objects$/,
  /^attachments\/v1\/tmp$/,
]

/** Extensions the walk is willing to treat as text. */
const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'log', 'yml', 'yaml', 'json', 'jsonc', 'toml', 'ini', 'cfg', 'conf',
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'sh', 'ps1', 'html', 'css', 'csv', 'xml',
])

/** Files whose whole point is a secret: the panel hides the body, so the walk never reads it. */
const CREDENTIAL_NAME = /^\.credentials/

/**
 * Hide the values behind the keys a config file spells out.
 *
 * Redaction happens here, on the Host, because the payload crosses to the
 * browser: a credential that never leaves the process cannot leak from the page.
 * @param text - file text as read.
 * @returns the same text with credential-looking values replaced.
 */
export function redact(text: string): string {
  return text
    .split('\n')
    .map(line => (/(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential)\s*["']?\s*[:=]/i.test(line)
      ? line.replace(/([:=]).*$/, '$1 [已遮盖]')
      : line))
    .join('\n')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[已遮盖]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已遮盖]@')
    .replace(/([?&](?:key|token|secret|password|access_token)=)[^\s&#"']+/gi, '$1[已遮盖]')
}

/** Where the DSH home directory is, honouring an explicit `DSH_HOME`. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Format an epoch-millisecond time the way the table's own time column reads. */
function stamp(mtime: number): string {
  const d = new Date(mtime)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Decide what a file's bytes contribute to the payload.
 * @param full - absolute path to read.
 * @param name - file name, for the credential and extension tests.
 * @param size - byte size already read from the directory entry.
 * @returns the inlined text, or the reason there is none.
 */
function fileBody(full: string, name: string, size: number): { text?: string; skip?: string } {
  if (CREDENTIAL_NAME.test(name)) return { skip: '此文件包含或可能包含登录凭据、密钥或授权信息，内容已整体隐藏。' }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (size > TEXT_LIMIT) return { skip: `文件 ${String(size)} 字节，超过 ${String(TEXT_LIMIT / 1024)} KiB 内联上限。` }
  if (!TEXT_EXT.has(ext)) return { skip: '快照未内联此文件正文（非文本格式或没有扩展名）。' }
  try {
    const bytes = readFileSync(full)
    const probe = bytes.subarray(0, 4096).toString('latin1')
    if (/[\u0000-\u0008\u000e-\u001f]/.test(probe)) return { skip: '二进制内容，快照不内联。' }
    return { text: redact(bytes.toString('utf8')) }
  } catch (error: unknown) {
    return { skip: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Whether the walk descends into this path. */
function expandable(rel: string, depth: number): boolean {
  return depth < MAX_DEPTH && !NO_EXPAND.some(re => re.test(rel))
}

/**
 * Walk one directory level.
 * @param dir - absolute directory to read.
 * @param rel - slash-joined path below the home directory, empty at the root.
 * @param depth - depth of this directory's entries.
 * @param blobs - accumulator for inlined text bodies.
 * @returns the entries, directories first, then names in locale order.
 */
function walk(dir: string, rel: string, depth: number, blobs: Record<string, string>): SnapshotNode[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error: unknown) {
    return [{
      name: '(无法读取)', directory: false, size: null, mtime: 0, advice: '需核对',
      note: `当前不可读取：${error instanceof Error ? error.message : String(error)}`,
    }]
  }

  const sorted = [...entries].sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory()))
    || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  const nodes: SnapshotNode[] = sorted.slice(0, MAX_CHILDREN).map((entry) => {
    const full = join(dir, entry.name)
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    const isDirectory = entry.isDirectory()
    let size: number | null = null
    let mtime = 0
    try {
      const info = statSync(full)
      mtime = info.mtimeMs
      if (!isDirectory) size = info.size
    } catch {
      // A vanished or unreadable entry keeps its name and the generic description.
    }
    const known = annotate(childRel, isDirectory)
    const node: SnapshotNode = {
      name: entry.name,
      directory: isDirectory,
      size,
      mtime,
      ...(known?.note === undefined ? {} : { note: known.note }),
      ...(known?.advice === undefined ? {} : { advice: known.advice }),
    }
    if (isDirectory && expandable(childRel, depth)) {
      return { ...node, children: walk(full, childRel, depth + 1, blobs) }
    }
    if (!isDirectory && size !== null) {
      const body = fileBody(full, entry.name, size)
      if (body.text !== undefined) blobs[childRel] = body.text
      if (body.skip !== undefined) return { ...node, skip: body.skip }
    }
    return node
  })

  const overflow = sorted.length - MAX_CHILDREN
  if (overflow > 0) {
    nodes.push({
      name: `…另有 ${String(overflow)} 项未列出`, directory: false, size: null, mtime: 0,
      note: `快照只列前 ${String(MAX_CHILDREN)} 项`, advice: '需核对',
    })
  }
  return nodes
}

/**
 * Read the whole payload the panel renders.
 *
 * There is no cache: the walk is a few hundred directory entries and a couple of
 * dozen small files, and a stale answer to "what is in here" is worse than a
 * slow one.
 * @returns the snapshot, ready to serialize.
 */
export function readSnapshot(): Snapshot {
  const home = dshHome()
  const blobs: Record<string, string> = {}
  const root = walk(home, '', 0, blobs)
  const byName = new Map(root.map(node => [node.name, node]))
  const items: TopNoteRow[] = TOP_NOTES.map((top) => {
    const node = byName.get(top.name)
    return {
      ...top,
      directory: node?.directory ?? false,
      modified: node === undefined ? '—' : stamp(node.mtime),
      size: node?.size ?? null,
    }
  })
  return { captured: stamp(Date.now()), items, root, blobs }
}
