import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRIGGER_LEDGER_LIMIT, createStore, messageKey, type MailStore } from '../src/store.ts'
import type { MailAccount, MailSummary } from '../src/types.ts'

/** Every temp directory this file created, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A store on a fresh temp file, plus the paths around it. */
async function tempStore(): Promise<{ path: string; store: MailStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'mail-store-'))
  tempDirs.push(dir)
  const path = join(dir, 'mail', 'state.json')
  return { path, store: createStore({ path }) }
}

/** Write raw content to a state file, creating its directory. */
async function writeRaw(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** One account record the panel would have saved. */
function account(id: string, address: string): MailAccount {
  return {
    id,
    name: address,
    address,
    provider: 'qq',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    secure: true,
    trigger: { mode: 'panel', filters: {} },
  }
}

describe('messageKey', () => {
  it('names one message by folder, mailbox generation and uid', () => {
    expect(messageKey('INBOX', 7, 42)).toBe('INBOX:7:42')
    expect(messageKey('[Gmail]/All Mail', 1, 1)).toBe('[Gmail]/All Mail:1:1')
  })
})

describe('load', () => {
  it('answers an empty state before anything was written', async () => {
    const { store } = await tempStore()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.accounts()).toEqual([])
    expect(store.cursor('x', 'INBOX')).toBeUndefined()
    expect(store.isTriggered('x', messageKey('INBOX', 1, 1))).toBe(false)
    expect(store.folderFor('x')).toBeUndefined()
  })

  it('answers an empty state for a file it cannot vouch for', async () => {
    const { path, store } = await tempStore()
    for (const content of [
      'not json',
      '[]',
      'null',
      '{"version":2,"accounts":{}}',
      '{"version":"1","accounts":{}}',
      '{"version":1,"accounts":[]}',
      '{"version":1}',
    ]) {
      await writeRaw(path, content)
      await expect(store.load()).resolves.toBeUndefined()
      expect(store.accounts()).toEqual([])
    }
  })

  it('drops the records it cannot read and keeps the rest', async () => {
    const { path, store } = await tempStore()
    await writeRaw(path, JSON.stringify({
      version: 1,
      accounts: {
        broken: 42,
        partial: {
          cursors: { INBOX: { uidValidity: 'x', lastUid: 3 }, Sent: { uidValidity: 2, lastUid: 9 } },
          triggered: [{ key: 'INBOX:1:2', at: '2024-01-01T00:00:00.000Z' }, { nothing: true }, 'nope'],
          folder: 'INBOX',
        },
      },
    }))
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.accounts()).toEqual([])
    expect(store.cursor('partial', 'INBOX')).toBeUndefined()
    expect(store.cursor('partial', 'Sent')).toEqual({ folder: 'Sent', uidValidity: 2, lastUid: 9 })
    expect(store.isTriggered('partial', 'INBOX:1:2')).toBe(true)
    expect(store.isTriggered('partial', 'INBOX:1:3')).toBe(false)
    expect(store.folderFor('partial')).toBe('INBOX')
  })
})

describe('accounts', () => {
  it('keeps the order it was given, across a restart', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com'), account('mb', 'b@x.com')])
    expect(store.accounts().map(item => item.id)).toEqual(['ma', 'mb'])

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.accounts().map(item => item.id)).toEqual(['ma', 'mb'])
    expect(reopened.accounts()[0]).toEqual(account('ma', 'a@x.com'))
  })

  it('drops the state of an account the new list no longer has', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    await store.setCursor('ma', 'INBOX', { folder: 'INBOX', uidValidity: 3, lastUid: 10 })
    await store.setAccounts([])
    expect(store.cursor('ma', 'INBOX')).toBeUndefined()

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.accounts()).toEqual([])
  })
})

describe('cursors', () => {
  it('reads back what it wrote, in this process and the next', async () => {
    const { path, store } = await tempStore()
    await store.load()
    expect(store.cursor('ma', 'INBOX')).toBeUndefined()
    await store.setCursor('ma', 'INBOX', { folder: 'INBOX', uidValidity: 3, lastUid: 10 })
    expect(store.cursor('ma', 'INBOX')).toEqual({ folder: 'INBOX', uidValidity: 3, lastUid: 10 })

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.cursor('ma', 'INBOX')).toEqual({ folder: 'INBOX', uidValidity: 3, lastUid: 10 })
  })

  it('lands every write the panel made in a burst', async () => {
    const { path, store } = await tempStore()
    await store.load()
    const folders = ['INBOX', 'Sent', 'Drafts', 'Archive', 'Trash']
    await Promise.all(folders.map((folder, index) => store.setCursor('ma', folder, { folder, uidValidity: 1, lastUid: index + 1 })))

    const reopened = createStore({ path })
    await reopened.load()
    for (const [index, folder] of folders.entries()) {
      expect(reopened.cursor('ma', folder)).toEqual({ folder, uidValidity: 1, lastUid: index + 1 })
    }
  })
})

describe('trigger ledger', () => {
  it('remembers a message once, whatever the order it is asked in', async () => {
    const { path, store } = await tempStore()
    await store.load()
    const key = messageKey('INBOX', 5, 100)
    expect(store.isTriggered('ma', key)).toBe(false)
    await store.markTriggered('ma', key)
    await store.markTriggered('ma', key)
    expect(store.isTriggered('ma', key)).toBe(true)

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.isTriggered('ma', key)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).accounts.ma.triggered).toHaveLength(1)
  })

  it('trims the oldest keys once the ledger is full, and keeps the newest', async () => {
    const { path, store } = await tempStore()
    await store.load()
    const keys = Array.from({ length: TRIGGER_LEDGER_LIMIT + 1 }, (_, index) => messageKey('INBOX', 1, index + 1))
    for (const key of keys) await store.markTriggered('ma', key)

    const persisted = JSON.parse(await readFile(path, 'utf8')).accounts.ma.triggered
    expect(persisted).toHaveLength(TRIGGER_LEDGER_LIMIT)
    expect(persisted.at(-1).key).toBe(keys.at(-1))

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.isTriggered('ma', keys[0]!)).toBe(false)
    expect(reopened.isTriggered('ma', keys.at(-1)!)).toBe(true)
  })
})

describe('folderFor', () => {
  it('keeps the folder the account was last scanned in', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setFolderFor('ma', 'INBOX')
    expect(store.folderFor('ma')).toBe('INBOX')
    await store.setFolderFor('ma', 'Archive')
    expect(store.folderFor('ma')).toBe('Archive')

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.folderFor('ma')).toBe('Archive')
  })
})

describe('forget', () => {
  it('drops the account, its cursors and its ledger', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    await store.setCursor('ma', 'INBOX', { folder: 'INBOX', uidValidity: 1, lastUid: 3 })
    await store.markTriggered('ma', messageKey('INBOX', 1, 3))
    await store.forget('ma')
    expect(store.accounts()).toEqual([])
    expect(store.cursor('ma', 'INBOX')).toBeUndefined()
    expect(store.isTriggered('ma', messageKey('INBOX', 1, 3))).toBe(false)

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.accounts()).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8')).accounts).toEqual({})
  })
})

describe('forgetFolder', () => {
  it('drops one folder and leaves every other one alone', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    await store.setCursor('ma', 'INBOX', { folder: 'INBOX', uidValidity: 1, lastUid: 3 })
    await store.setCursor('ma', 'Archive', { folder: 'Archive', uidValidity: 1, lastUid: 5 })
    await store.markTriggered('ma', messageKey('INBOX', 1, 3))
    await store.markTriggered('ma', messageKey('Archive', 1, 5))

    await store.forgetFolder('ma', 'INBOX')

    // A mailbox whose UIDVALIDITY changed is gone in every sense (RFC 2683
    // §3.4.3): a stale UID is how a client ends up acting on a message that no
    // longer exists — or, worse, on a different one.
    expect(store.cursor('ma', 'INBOX')).toBeUndefined()
    expect(store.isTriggered('ma', messageKey('INBOX', 1, 3))).toBe(false)
    expect(store.cursor('ma', 'Archive')).toEqual({ folder: 'Archive', uidValidity: 1, lastUid: 5 })
    expect(store.isTriggered('ma', messageKey('Archive', 1, 5))).toBe(true)
    expect(store.accounts()).toHaveLength(1)

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.cursor('ma', 'INBOX')).toBeUndefined()
    expect(reopened.isTriggered('ma', messageKey('Archive', 1, 5))).toBe(true)
  })
})

/** One list row, shaped the way the scanner produces them. */
function row(uid: number): MailSummary {
  return {
    accountId: 'ma',
    folder: 'INBOX',
    uid,
    uidValidity: 1,
    subject: `S${String(uid)}`,
    from: { address: 'a@x.com' },
    date: '2026-01-01T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: '',
  }
}

describe('the remembered list', () => {
  it('reads back the rows and when they were taken, in this process and the next', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    const at = '2026-01-01T00:00:00.000Z'
    const messages = [row(1), row(2)]

    await store.saveMessages('ma', { at, messages })
    expect(store.cachedMessages('ma')).toEqual({ at, messages })

    const reopened = createStore({ path })
    await reopened.load()
    expect(reopened.cachedMessages('ma')?.at).toBe(at)
    expect(reopened.cachedMessages('ma')?.messages).toHaveLength(2)
  })

  it('drops a snapshot it cannot trust instead of refusing to load', async () => {
    const { path, store } = await tempStore()
    await writeRaw(path, JSON.stringify({
      version: 1,
      accounts: {
        ma: {
          account: account('ma', 'a@x.com'),
          cursors: {},
          triggered: [],
          messages: { at: 7, messages: 'nope' },
        },
      },
    }))

    await store.load()

    // A hand-edited file must not cost the user the panel: the rows go, the
    // account stays.
    expect(store.cachedMessages('ma')).toBeUndefined()
    expect(store.accounts()).toHaveLength(1)
  })

  it('forgets the snapshot together with the account', async () => {
    const { store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    await store.saveMessages('ma', { at: '2026-01-01T00:00:00.000Z', messages: [row(1)] })

    await store.forget('ma')

    expect(store.cachedMessages('ma')).toBeUndefined()
  })
})

describe('the file itself', () => {
  it('is written whole and leaves no temporary behind', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    await store.setCursor('ma', 'INBOX', { folder: 'INBOX', uidValidity: 4, lastUid: 12 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      accounts: { ma: { cursors: { INBOX: { folder: 'INBOX', uidValidity: 4, lastUid: 12 } }, account: { id: 'ma' } } },
    })
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('is readable only by its owner', async () => {
    const { path, store } = await tempStore()
    await store.load()
    await store.setAccounts([account('ma', 'a@x.com')])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
