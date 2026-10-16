/**
 * What the Host half promises the panel: the tree stops where it should, the
 * small text files travel redacted, and nothing a credential file holds leaves
 * the process.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { annotate } from '../src/notes.ts'
import { readSnapshot, redact, type SnapshotNode } from '../src/snapshot.ts'

let home = ''

/** Write one fixture file, creating its directory. */
function put(rel: string, body: string): void {
  const full = join(home, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

/** Find one node by walking the snapshot's root entries. */
function find(nodes: readonly SnapshotNode[], name: string): SnapshotNode | undefined {
  return nodes.find(node => node.name === name)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-guide-'))
  process.env.DSH_HOME = home
  put('AGENTS.md', '# 用户全局指令\napi_key: sk-abcdefghijklmnop\n')
  put('.credentials.yaml', 'refs:\n  - name: real-secret\n')
  put('profiles/desktop/cordis.patch.yml', '- id: ui-chat\n')
  put('sessions/--D-open-repo--/session-abc/transcript.jsonl', '{"kind":"user"}\n')
  put('storages/plugin-store/plugin-store.sqlite', 'SQLite format 3\u0000rest')
  put('storages/plugin-store/plugin-store.sqlite-wal', 'wal')
  put('logs/big.log', 'x'.repeat(70 * 1024))
  put('electron/electron.exe', 'MZ\u0000\u0000binary')
  put('notes/fake.md', 'ok\u0000\u0001not really markdown')
  put('a/b/c/d.txt', 'too deep to list\n')
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('readSnapshot', () => {
  const snapshot = () => readSnapshot()

  it('lists the home directory entries with their facts read off disk', () => {
    const snap = snapshot()
    expect(snap.root.map(node => node.name)).toContain('AGENTS.md')
    expect(snap.root.map(node => node.name)).toContain('profiles')
    expect(snap.captured).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    const agents = find(snap.root, 'AGENTS.md')
    expect(agents?.directory).toBe(false)
    expect(agents?.size).toBeGreaterThan(0)
  })

  it('carries the hand-written notes, matched to what is on disk', () => {
    const snap = snapshot()
    const agents = snap.items.find(item => item.name === 'AGENTS.md')
    expect(agents?.advice).toBe('保留')
    expect(agents?.directory).toBe(false)
    expect(agents?.modified).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    // A note for an entry this fixture never created still lists, with no facts.
    const pet = snap.items.find(item => item.name === 'pet.json')
    expect(pet?.modified).toBe('—')
  })

  it('inlines small text files, redacted before they leave the process', () => {
    const snap = snapshot()
    expect(snap.blobs['AGENTS.md']).toContain('用户全局指令')
    expect(snap.blobs['AGENTS.md']).toContain('[已遮盖]')
    expect(snap.blobs['AGENTS.md']).not.toContain('sk-abcdefghijklmnop')
    expect(snap.blobs['profiles/desktop/cordis.patch.yml']).toContain('ui-chat')
  })

  it('never reads a credential file, and never inlines a large or binary one', () => {
    const snap = snapshot()
    expect(snap.blobs['.credentials.yaml']).toBeUndefined()
    expect(find(snap.root, '.credentials.yaml')?.skip).toMatch(/已整体隐藏/)
    expect(snap.blobs['logs/big.log']).toBeUndefined()
    expect(find(find(snap.root, 'logs')?.children ?? [], 'big.log')?.skip).toMatch(/内联上限/)
    expect(find(find(snap.root, 'notes')?.children ?? [], 'fake.md')?.skip).toMatch(/二进制/)
    // `electron` is hundreds of megabytes of binaries: it is named, never entered.
    expect(find(snap.root, 'electron')?.children).toBeUndefined()
  })

  it('stops two levels below the home directory', () => {
    const snap = snapshot()
    const profiles = find(snap.root, 'profiles')
    const desktop = find(profiles?.children ?? [], 'desktop')
    expect(desktop?.children?.map(node => node.name)).toContain('cordis.patch.yml')
    // a/b/c sits at depth 2 and is therefore named but not entered.
    const a = find(snap.root, 'a')
    const b = find(a?.children ?? [], 'b')
    const c = find(b?.children ?? [], 'c')
    expect(c).toBeDefined()
    expect(c?.children).toBeUndefined()
  })

  it('marks a SQLite sidecar as belonging to its main database', () => {
    const snap = snapshot()
    const store = find(find(find(snap.root, 'storages')?.children ?? [], 'plugin-store')?.children ?? [], 'plugin-store.sqlite-wal')
    expect(store?.advice).toBe('随主库')
    const main = find(find(find(snap.root, 'storages')?.children ?? [], 'plugin-store')?.children ?? [], 'plugin-store.sqlite')
    expect(main?.advice).toBe('需核对')
  })

  it('says what a session directory is without entering it', () => {
    const snap = snapshot()
    const repo = find(find(snap.root, 'sessions')?.children ?? [], '--D-open-repo--')
    expect(repo?.note).toMatch(/按工作目录分桶/)
    const session = find(repo?.children ?? [], 'session-abc')
    expect(session?.note).toMatch(/单次会话记录/)
  })
})

describe('redact', () => {
  it('hides values behind credential-looking keys and keeps the rest', () => {
    expect(redact('api_key: abc123\nplain: ok')).toBe('api_key: [已遮盖]\nplain: ok')
    expect(redact('Authorization: Bearer xyz')).toBe('Authorization: [已遮盖]')
    expect(redact('url: https://user:pw@example.com/x')).toBe('url: https://[已遮盖]@example.com/x')
    // Whether the query rule or the key/`=` rule catches it, the value must go.
    expect(redact('?token=abc&x=1')).not.toContain('abc')
    expect(redact('?token=abc&x=1')).toContain('[已遮盖]')
    expect(redact('nothing to hide')).toBe('nothing to hide')
  })
})

describe('annotate', () => {
  it('leaves an unknown path to the panel generic description', () => {
    expect(annotate('something/else.txt', false)).toBeNull()
  })
})
