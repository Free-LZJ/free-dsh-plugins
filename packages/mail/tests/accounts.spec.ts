import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountIdFor,
  credentialKeyFor,
  readPassword,
  removePassword,
  testAccount,
  writePassword,
  type CredentialsLike,
  type ProbeFn,
} from '../src/accounts.ts'
import { createStore } from '../src/store.ts'
import type { DraftAccount, MailAccount, MailConfigView } from '../src/types.ts'

/** An authorization code standing in for a real one; the tests only look for it. */
const PASSWORD = 'xqzj-8f3k-2m9p-7rtv'

/** Every temp directory this file created, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The credentials service, in memory, with the records it holds exposed. */
interface FakeCredentials extends CredentialsLike {
  readonly records: Map<string, { kind: string; key?: string }>
}

function fakeCredentials(): FakeCredentials {
  const records = new Map<string, { kind: string; key?: string }>()
  return {
    records,
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = mutate(records.get(key))
      if (typeof next === 'object' && next !== null) records.set(key, next as { kind: string; key?: string })
      return next
    },
    deleteRecord: async (key) => {
      records.delete(key)
    },
  }
}

/** The error a promise rejected with, for inspecting its `code`. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('the promise resolved')
}

/** One account record, as the panel would have saved it. */
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

describe('accountIdFor', () => {
  it('is stable, case-insensitive and shaped like a credentials key segment', () => {
    const id = accountIdFor('A@x.com', 'qq')
    expect(id).toBe(accountIdFor('a@x.com', 'qq'))
    expect(id).toBe(accountIdFor('  a@x.com  ', 'qq'))
    expect(id).toBe(accountIdFor('a@x.com', 'qq'))
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(id).toHaveLength(16)
  })

  it('tells two mailboxes apart, including one address on two providers', () => {
    expect(accountIdFor('a@x.com', 'qq')).not.toBe(accountIdFor('b@x.com', 'qq'))
    expect(accountIdFor('a@x.com', 'qq')).not.toBe(accountIdFor('a@x.com', 'gmail'))
    expect(accountIdFor('a@x.com', 'custom')).not.toBe(accountIdFor('a@x.com', 'gmail'))
  })
})

describe('credentialKeyFor', () => {
  it('scopes the key to this plugin, which is what the service checks', () => {
    expect(credentialKeyFor('m0123456789abcde')).toBe('dsh-mail/m0123456789abcde')
    expect(credentialKeyFor('m0123456789abcde').split('/')).toHaveLength(2)
  })
})

describe('the authorization code', () => {
  it('reads back what was written, and forgets it when removed', async () => {
    const credentials = fakeCredentials()
    const id = accountIdFor('a@x.com', 'qq')
    await expect(readPassword(credentials, id)).resolves.toBeUndefined()
    await writePassword(credentials, id, PASSWORD)
    await expect(readPassword(credentials, id)).resolves.toBe(PASSWORD)
    expect(credentials.records.get(credentialKeyFor(id))).toEqual({ kind: 'api-key', key: PASSWORD })
    await removePassword(credentials, id)
    await expect(readPassword(credentials, id)).resolves.toBeUndefined()
  })

  it('treats a record of another shape as nothing configured', async () => {
    const credentials = fakeCredentials()
    const id = accountIdFor('a@x.com', 'qq')
    for (const record of [{ kind: 'env' }, { kind: 'api-key' }, { kind: 'api-key', key: '' }, { kind: 'api-key', key: 7 }]) {
      credentials.records.set(credentialKeyFor(id), record as { kind: string; key?: string })
      await expect(readPassword(credentials, id)).resolves.toBeUndefined()
    }
  })

  it('answers reads with nothing and refuses writes when the host mounted no service', async () => {
    const id = accountIdFor('a@x.com', 'qq')
    await expect(readPassword(undefined, id)).resolves.toBeUndefined()
    const write = await rejection(writePassword(undefined, id, PASSWORD))
    expect(write).toMatchObject({ code: 'credentials_unavailable' })
    expect(write).toBeInstanceOf(Error)
    expect(await rejection(removePassword(undefined, id))).toMatchObject({ code: 'credentials_unavailable' })
  })

  it('never puts the code in anything the panel can reach', async () => {
    const credentials = fakeCredentials()
    const id = accountIdFor('a@x.com', 'qq')
    const view: MailConfigView = { fallbackScanSeconds: 300, maxListMessages: 100, accounts: [account(id, 'a@x.com')], triggerAvailability: { session: false, notify: false }, presets: { agents: [], permissions: [] } }
    const dir = await mkdtemp(join(tmpdir(), 'mail-accounts-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.json')
    const store = createStore({ path })
    await store.load()
    await store.setAccounts(view.accounts)
    await writePassword(credentials, id, PASSWORD)

    // The panel's whole view, the account record, the key and the plugin's own
    // file must not carry it — only readPassword hands it to the IMAP module.
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
    expect(JSON.stringify(account(id, 'a@x.com'))).not.toContain(PASSWORD)
    expect(credentialKeyFor(id)).not.toContain(PASSWORD)
    expect(await readFile(path, 'utf8')).not.toContain(PASSWORD)
    expect(await readPassword(credentials, id)).toBe(PASSWORD)
  })
})

describe('testAccount', () => {
  const draft: DraftAccount = { address: 'a@x.com', imapHost: 'imap.qq.com', imapPort: 993, secure: true, password: PASSWORD }

  it('hands the draft and the timeout to the probe and passes its answer back', async () => {
    const calls: { draft: DraftAccount; timeoutSeconds: number }[] = []
    const probe: ProbeFn = async (given, timeoutSeconds) => {
      calls.push({ draft: given, timeoutSeconds })
      return { ok: true, mailboxes: 4 }
    }
    await expect(testAccount(probe, draft, 30)).resolves.toEqual({ ok: true, mailboxes: 4 })
    expect(calls).toEqual([{ draft, timeoutSeconds: 30 }])
  })

  it('passes a failed probe through as the route\'s error', async () => {
    const probe: ProbeFn = async () => ({ ok: false, code: 'auth_failed', message: 'Login failed' })
    await expect(testAccount(probe, draft, 30)).resolves.toEqual({ ok: false, code: 'auth_failed', message: 'Login failed' })
  })
})
