/**
 * What the IMAP layer must never get wrong: every range travels with
 * `{ uid: true }`, a failed SEARCH leaves the cursor where it was, a pass takes
 * the newest messages rather than the oldest, and triage never expunges.
 *
 * Nothing here opens a socket: the factory hands over scripted clients that
 * record what they were asked to do and can be made to fail on cue.
 */

import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAccount, MailAction } from '../src/types.ts'
import {
  MailOfflineError, createConnection, probeAccount, scanFolder,
  type ImapClientLike, type ImapFactory, type MailFlagUpdate, type ScanOptions,
} from '../src/imap.ts'

/** One yielded FETCH result, without the generator plumbing. */
type FetchedMessage = Exclude<Awaited<ReturnType<ImapClientLike['fetchOne']>>, false | undefined>

/** What a download answers with. */
type Downloaded = Awaited<ReturnType<ImapClientLike['download']>>

/** One call a scripted client received. */
interface RecordedCall {
  readonly method: string
  readonly args: readonly unknown[]
}

/** What the scripted client answers, and where it fails. */
interface FakeScript {
  /** Every UID the mailbox holds, ascending. Defaults to 1..3. */
  readonly mailbox?: readonly number[]
  /**
   * What the session's own SELECT view reports, which is where a scan now reads
   * the counters, the generation and the next UID from. `exists` defaults to the
   * size of `mailbox`; `uidValidity` and `uidNext` are absent unless scripted.
   *
   * `uidValidity` accepts a bigint because that is what imapflow reports for it.
   */
  readonly mailboxState?: { uidNext?: number; exists?: number; uidValidity?: number | bigint }
  /** What the new-mail SEARCH answers. Defaults to `mailbox`. */
  readonly search?: number[] | false | undefined
  /** What the unread-count `SEARCH UNSEEN` answers. Defaults to `mailbox`. */
  readonly unseen?: number[]
  readonly status?: { messages?: number; unseen?: number; uidValidity?: number } | false
  readonly list?: readonly { path: string; specialUse?: string }[]
  /**
   * UIDs the mailbox no longer holds, which FETCH answers nothing for.
   *
   * This is what an expunged message looks like on the wire: asking about it is
   * legal and simply produces no result.
   */
  readonly expunged?: readonly number[]
  readonly fetchOne?: FetchedMessage | false
  /** Content the download answers with, or false for "the part is not there". */
  readonly download?: { filename?: string; contentType?: string } | false
  /** Answer NO to every STORE, as a read-only folder would. */
  readonly refuseWrites?: boolean
  /** Value every write throws instead of running. */
  readonly failWrites?: unknown
  /** Value `connect()` throws instead of connecting. */
  readonly failConnect?: unknown
}

/** A scripted stand-in for one account's IMAP session. */
interface Fake {
  readonly factory: ImapFactory
  /** The options every factory call was handed. */
  readonly options: Record<string, unknown>[]
  readonly calls: RecordedCall[]
  /** Fire an event on the newest client, the way imapflow would. */
  emit(event: string, ...args: unknown[]): void
}

/** One FETCH result built from a UID, with a body the preview can read. */
function fetched(uid: number): FetchedMessage {
  return {
    uid,
    flags: new Set<string>(uid % 2 === 0 ? ['\\Seen'] : []),
    envelope: {
      subject: `Message ${String(uid)}`,
      from: [{ name: 'Sender', address: 'sender@example.com' }],
      date: new Date('2026-01-01T00:00:00Z'),
    },
    internalDate: new Date('2026-01-01T00:00:00Z'),
    size: 100,
    source: Buffer.from(`Subject: Message ${String(uid)}\n\nHello   mail ${String(uid)}\n`),
    bodyStructure: { type: 'text/plain' },
  }
}

/**
 * Build a factory whose clients are scripted end to end.
 * @param script - what the clients answer.
 * @returns the factory, the recorded calls and an event injector.
 */
function makeFake(script: FakeScript = {}): Fake {
  const mailbox = script.mailbox ?? [1, 2, 3]
  const calls: RecordedCall[] = []
  const options: Record<string, unknown>[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  const factory: ImapFactory = (given) => {
    options.push(given)
    // Listeners belong to one client: an event must not reach a session a
    // reconnect already replaced.
    listeners.clear()
    const client: ImapClientLike = {
      mailbox: { exists: mailbox.length, ...script.mailboxState },
      async connect(): Promise<void> {
        calls.push({ method: 'connect', args: [] })
        if (script.failConnect !== undefined) throw script.failConnect
      },
      async logout(): Promise<void> {
        calls.push({ method: 'logout', args: [] })
      },
      async noop(): Promise<void> {
        calls.push({ method: 'noop', args: [] })
      },
      close(): void {
        calls.push({ method: 'close', args: [] })
      },
      async list(): Promise<readonly { path: string; specialUse?: string }[]> {
        calls.push({ method: 'list', args: [] })
        return script.list ?? [{ path: 'INBOX', specialUse: '\\Inbox' }]
      },
      async status(path, query): Promise<{ messages?: number; unseen?: number } | false> {
        calls.push({ method: 'status', args: [path, query] })
        return script.status ?? { messages: mailbox.length, unseen: 1, uidValidity: 9 }
      },
      async getMailboxLock(path): Promise<{ release(): void }> {
        calls.push({ method: 'getMailboxLock', args: [path] })
        return { release: (): void => { calls.push({ method: 'release', args: [path] }) } }
      },
      async search(query, queryOptions): Promise<number[] | false | undefined> {
        calls.push({ method: 'search', args: [query, queryOptions] })
        // The unread count is its own `SEARCH UNSEEN` in the same pass, so the
        // script has to be able to answer the two searches differently.
        if ((query as { unseen?: unknown } | null)?.unseen === true) return script.unseen ?? [...mailbox]
        return script.search === undefined ? [...mailbox] : script.search
      },
      async *fetch(range, query, queryOptions) {
        calls.push({ method: 'fetch', args: [range, query, queryOptions] })
        const uids = Array.isArray(range) ? range.map(Number) : mailbox
        const gone = new Set(script.expunged ?? [])
        for (const uid of uids) {
          if (gone.has(uid)) continue
          yield fetched(uid)
        }
      },
      async fetchOne(seq, query, queryOptions): Promise<FetchedMessage | false | undefined> {
        calls.push({ method: 'fetchOne', args: [seq, query, queryOptions] })
        return script.fetchOne ?? fetched(Number(seq))
      },
      async messageFlagsAdd(range, flags, storeOptions): Promise<boolean> {
        calls.push({ method: 'messageFlagsAdd', args: [range, flags, storeOptions] })
        if (script.failWrites !== undefined) throw script.failWrites
        return script.refuseWrites !== true
      },
      async messageFlagsRemove(range, flags, storeOptions): Promise<boolean> {
        calls.push({ method: 'messageFlagsRemove', args: [range, flags, storeOptions] })
        if (script.failWrites !== undefined) throw script.failWrites
        return script.refuseWrites !== true
      },
      async messageDelete(range, storeOptions): Promise<boolean> {
        calls.push({ method: 'messageDelete', args: [range, storeOptions] })
        if (script.failWrites !== undefined) throw script.failWrites
        return script.refuseWrites !== true
      },
      async messageMove(range, destination, storeOptions): Promise<unknown> {
        calls.push({ method: 'messageMove', args: [range, destination, storeOptions] })
        if (script.failWrites !== undefined) throw script.failWrites
        return script.refuseWrites === true ? false : { path: destination }
      },
      async download(range, part, downloadOptions): Promise<Downloaded> {
        calls.push({ method: 'download', args: [range, part, downloadOptions] })
        if (script.download === false) return { content: undefined } as unknown as Downloaded
        return {
          meta: script.download ?? { filename: 'report.pdf', contentType: 'application/pdf' },
          content: Readable.from(['%PDF-1.4\n']),
        }
      },
      on(event, listener): unknown {
        calls.push({ method: 'on', args: [event] })
        const list = listeners.get(event) ?? []
        list.push(listener as unknown as (...args: unknown[]) => void)
        listeners.set(event, list)
        return undefined
      },
    }
    return client
  }

  return {
    factory,
    options,
    calls,
    emit(event: string, ...args: unknown[]): void {
      // Only the newest client is alive; the factory clears the map on every call.
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

/** A configured account, with only the fields imap.ts reads. */
function accountOf(): MailAccount {
  return {
    id: 'acct',
    name: 'Test',
    address: 'user@example.com',
    provider: 'custom',
    imapHost: 'imap.example.com',
    imapPort: 993,
    secure: true,
    trigger: { mode: 'panel', filters: {} },
  }
}

/** The scan options one test wants. */
function scanOptions(overrides: Partial<ScanOptions> = {}): ScanOptions {
  return {
    account: accountOf(),
    password: 'secret-code',
    folder: 'INBOX',
    fromUid: 1,
    knownUidValidity: 9,
    timeoutSeconds: 30,
    maxMessages: 100,
    ...overrides,
  }
}

/** The recorded calls of one method. */
function callsTo(fake: Fake, method: string): RecordedCall[] {
  return fake.calls.filter(call => call.method === method)
}

describe('scanFolder', () => {
  it('passes { uid: true } as the last argument of every search and fetch', async () => {
    const fake = makeFake({
      mailbox: [1, 2, 3, 4, 5],
      mailboxState: { exists: 5, uidValidity: 7 },
      unseen: [2, 4],
    })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ knownUidValidity: 7 }))

    // Two SEARCHes in one pass: the folder's unread count, then the new mail.
    const search = callsTo(fake, 'search')
    expect(search).toHaveLength(2)
    expect(search[0]?.args).toEqual([{ unseen: true }, { uid: true }])
    expect(search[1]?.args).toEqual([{ uid: '1:*' }, { uid: true }])

    const fetches = callsTo(fake, 'fetch')
    expect(fetches).toHaveLength(1)
    expect(fetches[0]?.args[2]).toEqual({ uid: true })
    // The range is a UID list, never a sequence range.
    expect(fetches[0]?.args[0]).toEqual([1, 2, 3, 4, 5])

    expect(outcome.uidValidity).toBe(7)
    expect(outcome.maxUid).toBe(5)
    expect(outcome.searchUnreliable).toBe(false)
    expect(outcome.messages).toHaveLength(5)
    expect(outcome.messages[0]?.summary).toMatchObject({
      accountId: 'acct',
      folder: 'INBOX',
      uid: 1,
      uidValidity: 7,
      subject: 'Message 1',
      seen: false,
    })
    expect(outcome.messages[1]?.summary.seen).toBe(true)
    expect(outcome.messages[0]?.summary.snippet).toBe('Hello mail 1')
    expect(outcome.messages[0]?.preview).toBe(outcome.messages[0]?.summary.snippet)
  })

  it('asks the server nothing when UIDNEXT says the mailbox has nothing new', async () => {
    const fake = makeFake({
      mailbox: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      mailboxState: { uidNext: 10, exists: 9, uidValidity: 7 },
    })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 10, knownUidValidity: 7 }))

    // `UID SEARCH 10:*` would always match the last message of a non-empty
    // mailbox (RFC 3501 §6.4.8 Note), so "did it answer" was never the question.
    // UIDNEXT answers it without a command (RFC 4549 §4.3.1).
    const newMail = callsTo(fake, 'search').filter(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(newMail).toEqual([])
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
    expect(outcome.messages).toEqual([])
    // The cursor may not advance: 10 means "start at 10", and nothing was read.
    expect(outcome.maxUid).toBe(9)
    expect(outcome.uidNext).toBe(10)
    // The rest of the answer still comes back, counters included, or the folder
    // tree would go blank on every quiet poll.
    expect(outcome.counters).toEqual({ total: 9, unseen: 9 })
    expect(outcome.uidValidity).toBe(7)
    expect(callsTo(fake, 'release')).toHaveLength(1)
  })

  it('bounds the new-mail search by UIDNEXT instead of an open range', async () => {
    const fake = makeFake({ mailbox: [5, 6, 7, 8, 9], mailboxState: { uidNext: 10, exists: 5, uidValidity: 7 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 5, knownUidValidity: 7 }))

    const newMail = callsTo(fake, 'search').find(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    // `5:9`, not `5:*`: the highest UID the server has handed out is UIDNEXT - 1.
    expect(newMail?.args[0]).toEqual({ uid: '5:9' })
    expect(outcome.maxUid).toBe(9)
    expect(outcome.uidNext).toBe(10)
  })

  it('leaves the cursor alone when SEARCH fails', async () => {
    const fake = makeFake({ search: false, mailboxState: { exists: 400, uidValidity: 7 } })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ fromUid: 11, knownUidValidity: 7 }))

    expect(outcome.messages).toEqual([])
    // 11 means "start at 11"; a failed SEARCH must not claim 11 was processed.
    expect(outcome.maxUid).toBe(10)
    // Nor may the UIDNEXT watermark advance past what the SEARCH listed.
    expect(outcome.uidNext).toBe(11)
    expect(outcome.searchUnreliable).toBe(false)
    expect(outcome.uidValidity).toBe(7)
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
    // The connection belongs to the caller: a scan never closes it.
    expect(callsTo(fake, 'close')).toHaveLength(0)
    expect(callsTo(fake, 'release')).toHaveLength(1)
  })

  it('enumerates by UID when SEARCH answers nothing for a mailbox the session says is not empty', async () => {
    const fake = makeFake({ mailbox: [1, 2, 3], search: [], mailboxState: { exists: 3, uidValidity: 4 } })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ knownUidValidity: 4 }))

    expect(outcome.searchUnreliable).toBe(true)
    expect(outcome.messages).toHaveLength(3)
    expect(outcome.maxUid).toBe(3)
    const fetches = callsTo(fake, 'fetch')
    expect(fetches).toHaveLength(2)
    expect(fetches[0]?.args[0]).toBe('1:*')
    for (const fetch of fetches) expect(fetch.args[2]).toEqual({ uid: true })
    const newMail = callsTo(fake, 'search').find(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(newMail?.args[1]).toEqual({ uid: true })
  })

  it('does not treat an empty SEARCH as unreliable when the folder really is empty', async () => {
    const fake = makeFake({ mailbox: [], search: [], mailboxState: { exists: 0, uidValidity: 4 } })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ knownUidValidity: 4 }))
    expect(outcome.searchUnreliable).toBe(false)
    expect(outcome.messages).toEqual([])
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
  })

  it('takes the newest messages when there are more than the cap', async () => {
    const mailbox = Array.from({ length: 500 }, (_, index) => index + 1)
    const fake = makeFake({ mailbox, mailboxState: { exists: 500, uidValidity: 4 } })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ maxMessages: 100, knownUidValidity: 4 }))

    const range = callsTo(fake, 'fetch')[0]?.args[0] as number[]
    expect(range).toHaveLength(100)
    // 401..500, not 1..100: a pass that is behind must catch up in one go, not
    // walk the backlog a hundred messages at a time.
    expect(range[0]).toBe(401)
    expect(range[99]).toBe(500)
    expect(outcome.maxUid).toBe(500)
    expect(outcome.messages).toHaveLength(100)
    expect(outcome.messages[0]?.summary.uid).toBe(401)
  })

  it('fetches nothing at all when the cap is zero', async () => {
    const fake = makeFake({ mailbox: [1, 2, 3, 4, 5] })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 3, maxMessages: 0 }))
    expect(outcome.messages).toEqual([])
    expect(outcome.maxUid).toBe(2)
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
  })

  it('re-reads the flags of the rows it was asked to refresh, in the same pass', async () => {
    const fake = makeFake({ mailbox: [1, 2], mailboxState: { exists: 2, uidValidity: 9 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ refreshUids: [3, 4] }))

    // Two FETCHes: the flag refresh, then the new mail itself.
    const fetches = callsTo(fake, 'fetch')
    expect(fetches).toHaveLength(2)
    // Identified by what it asks for rather than by position, so a reorder of the
    // two passes does not fail the test.
    const refresh = fetches.find((one) => (one.args[1] as { flags?: unknown }).flags === true)
    expect(refresh?.args).toEqual([[3, 4], { uid: true, flags: true }, { uid: true }])
    // `fetched()` marks even UIDs seen, so 4 reads as read and 3 does not.
    expect(outcome.refreshed).toEqual([
      { uid: 3, seen: false, flagged: false },
      { uid: 4, seen: true, flagged: false },
    ])
  })

  it('asks for no flag refresh when nothing is on screen yet', async () => {
    const fake = makeFake({ mailbox: [1, 2] })
    const outcome = await scanFolder(fake.factory({}), scanOptions())
    expect(callsTo(fake, 'fetch')).toHaveLength(1)
    expect(outcome.refreshed).toEqual([])
  })

  it('takes the counters from the session that is scanning, never from a STATUS of it', async () => {
    const fake = makeFake({ mailbox: [1, 2], mailboxState: { exists: 9 }, unseen: [1, 2, 4] })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ knownUidValidity: 9 }))

    // SELECT's EXISTS, and the length of this pass's own `SEARCH UNSEEN` — not a
    // count over the two messages this pass returned, and not a STATUS, which
    // RFC 3501 §6.3.10 tells clients not to run on the selected mailbox because
    // its answer need not agree with this session's view.
    expect(outcome.counters).toEqual({ total: 9, unseen: 3 })
    expect(callsTo(fake, 'status')).toEqual([])
    const unseen = callsTo(fake, 'search')[0]
    expect(unseen?.args).toEqual([{ unseen: true }, { uid: true }])
  })

  it('turns the BigInt UIDVALIDITY imapflow reports into a plain number', async () => {
    // `MailboxObject.uidValidity` is a bigint, and a BigInt that reaches
    // JSON.stringify throws — which fails the whole state response, so the panel
    // showed an empty list because one field could not be serialized.
    const fake = makeFake({ mailbox: [1, 2], mailboxState: { uidValidity: 42n } })

    const outcome = await scanFolder(fake.factory({}), scanOptions({ knownUidValidity: 7 }))

    expect(typeof outcome.uidValidity).toBe('number')
    expect(outcome.uidValidity).toBe(42)
    expect(outcome.messages[0]?.summary.uidValidity).toBe(42)
  })

  it('keeps the known validity when the reported one will not fit in a number', async () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n
    const fake = makeFake({ mailbox: [1, 2], mailboxState: { uidValidity: huge } })

    const outcome = await scanFolder(fake.factory({}), scanOptions({ knownUidValidity: 7 }))

    // Rounding it would name a different mailbox generation; the caller's last
    // known value is the honest answer.
    expect(outcome.uidValidity).toBe(7)
  })

  it('asks the server to catch it up before trusting the selected mailbox view', async () => {
    const fake = makeFake({ mailbox: [1, 2], mailboxState: { exists: 2, uidValidity: 9 } })
    await scanFolder(fake.factory({}), scanOptions({ knownUidValidity: 9 }))

    // Dovecot answers STATUS/FETCH for a selected mailbox from the connection's
    // own view; only a NOOP (or IDLE, or another SELECT) moves it forward
    // (RFC 3501 §6.1.2). It has to come before the reads it is meant to refresh.
    const order = fake.calls.map(call => call.method)
    expect(order).toContain('noop')
    expect(order.indexOf('noop')).toBeLessThan(order.indexOf('search'))
  })

  it('reports a refreshed UID the server no longer lists as vanished', async () => {
    const fake = makeFake({
      mailbox: [1, 2],
      mailboxState: { exists: 2, uidValidity: 9 },
      expunged: [4],
    })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ refreshUids: [3, 4] }))

    // 3 came back, 4 did not: the panel has to drop that row. Nothing else in
    // IMAP reports a deletion performed by another client.
    expect(outcome.refreshed).toEqual([{ uid: 3, seen: false, flagged: false }])
    expect(outcome.vanished).toEqual([4])
  })

  it('builds a client from the account details', async () => {
    const fake = makeFake()
    // A scan no longer opens a connection of its own, so the options are asserted
    // where they are assembled: creating the account's connection.
    await createConnection(fake.factory, accountOf(), 'secret-code', 30).start()
    expect(fake.options[0]).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'user@example.com', pass: 'secret-code' },
      clientInfo: { name: 'dsh-mail', vendor: 'free-lzj' },
      logger: false,
      socketTimeout: 30_000,
      connectionTimeout: 30_000,
      // RFC 2177 §3: IDLE is re-issued well inside the 29-minute advice.
      maxIdleTime: 1_500_000,
    })
  })
})

describe('createConnection actions', () => {
  /** One connected client plus its calls. */
  async function connected(script: FakeScript = {}): Promise<{ fake: Fake; connection: ReturnType<typeof createConnection> }> {
    const fake = makeFake(script)
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    return { fake, connection }
  }

  const actions: readonly (MailAction & { readonly method: string; readonly args: readonly unknown[] })[] = [
    { op: 'markRead', accountId: 'acct', folder: 'INBOX', uids: [4, 9], method: 'messageFlagsAdd', args: [[4, 9], ['\\Seen'], { uid: true }] },
    { op: 'markUnread', accountId: 'acct', folder: 'INBOX', uids: [4, 9], method: 'messageFlagsRemove', args: [[4, 9], ['\\Seen'], { uid: true }] },
    { op: 'flag', accountId: 'acct', folder: 'INBOX', uids: [4, 9], method: 'messageFlagsAdd', args: [[4, 9], ['\\Flagged'], { uid: true }] },
    { op: 'unflag', accountId: 'acct', folder: 'INBOX', uids: [4, 9], method: 'messageFlagsRemove', args: [[4, 9], ['\\Flagged'], { uid: true }] },
    { op: 'delete', accountId: 'acct', folder: 'INBOX', uids: [4, 9], method: 'messageDelete', args: [[4, 9], { uid: true }] },
    { op: 'move', accountId: 'acct', folder: 'INBOX', uids: [4, 9], targetFolder: 'Trash', method: 'messageMove', args: [[4, 9], 'Trash', { uid: true }] },
  ]

  for (const action of actions) {
    it(`sends ${action.op} by UID, inside one lock`, async () => {
      const { fake, connection } = await connected()
      // `start()` takes a lock of its own to select the watched folder (and
      // releases it, so auto-IDLE can run), so count what this action adds.
      const locks = callsTo(fake, 'getMailboxLock').length
      const releases = callsTo(fake, 'release').length
      const result = await connection.applyAction(action)
      expect(result).toEqual({ ok: true, applied: 2 })

      const sent = callsTo(fake, action.method)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.args).toEqual(action.args)
      expect(callsTo(fake, 'getMailboxLock').length - locks).toBe(1)
      expect(callsTo(fake, 'release').length - releases).toBe(1)
    })
  }

  it('scans on the connection it already has instead of opening another', async () => {
    const fake = makeFake({ mailbox: [1, 2] })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    const connects = callsTo(fake, 'connect').length

    await connection.scan({ folder: 'INBOX', fromUid: 1, knownUidValidity: 9, maxMessages: 100 })

    // One session per account: a second one on the same mailbox is what RFC 2683
    // §3.1.1 says to avoid, and it would drop the first session's selected folder.
    expect(callsTo(fake, 'connect')).toHaveLength(connects)
    expect(callsTo(fake, 'close')).toHaveLength(0)
    expect(callsTo(fake, 'search').length).toBeGreaterThan(0)
  })

  it('selects the watched folder on start and lets go of the lock at once', async () => {
    const fake = makeFake()
    await createConnection(fake.factory, accountOf(), 'secret-code', 30).start()

    expect(callsTo(fake, 'getMailboxLock')[0]?.args).toEqual(['INBOX'])
    // Released immediately: a selected mailbox is what IDLE reports changes for,
    // while a held lock would stop auto-IDLE from ever starting.
    expect(callsTo(fake, 'release')).toHaveLength(1)
  })

  it('never expunges after a delete', async () => {
    const { fake, connection } = await connected()
    await connection.applyAction({ op: 'delete', accountId: 'acct', folder: 'INBOX', uids: [4] })
    expect(fake.calls.filter(call => /expunge/i.test(call.method))).toEqual([])
  })

  it('refuses a range that is empty, non-positive or oversized', async () => {
    const { fake, connection } = await connected()
    const tooMany = Array.from({ length: 501 }, (_, index) => index + 1)
    for (const uids of [[], [0, 3], [-1], tooMany]) {
      const result = await connection.applyAction({ op: 'markRead', accountId: 'acct', folder: 'INBOX', uids })
      expect(result).toMatchObject({ ok: false, code: 'invalid_action' })
    }
    expect(callsTo(fake, 'messageFlagsAdd')).toHaveLength(0)
  })

  it('reports an offline account when there is no session', async () => {
    const { connection } = await connected()
    await connection.stop()
    await expect(connection.applyAction({ op: 'flag', accountId: 'acct', folder: 'INBOX', uids: [1] }))
      .resolves.toMatchObject({ ok: false, code: 'account_offline' })
  })

  it('reports a command the server refused as imap_rejected', async () => {
    const { connection } = await connected({ refuseWrites: true })
    await expect(connection.applyAction({ op: 'flag', accountId: 'acct', folder: 'INBOX', uids: [1] }))
      .resolves.toMatchObject({ ok: false, code: 'imap_rejected' })
  })

  it('reports a dropped connection mid-command as account_offline', async () => {
    const dropped = makeFake({ failWrites: Object.assign(new Error('Connection not available'), { code: 'NoConnection' }) })
    const connection = createConnection(dropped.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    await expect(connection.applyAction({ op: 'flag', accountId: 'acct', folder: 'INBOX', uids: [1] }))
      .resolves.toMatchObject({ ok: false, code: 'account_offline' })
  })

  it('finds a detail, and answers undefined for a message that is gone', async () => {
    const { connection } = await connected()
    const detail = await connection.fetchDetail('INBOX', 5, 100)
    expect(detail?.subject).toBe('Message 5')
    expect(detail?.truncated).toBe(false)

    const missing = makeFake({ fetchOne: false })
    const gone = createConnection(missing.factory, accountOf(), 'secret-code', 30)
    await gone.start()
    await expect(gone.fetchDetail('INBOX', 5)).resolves.toBeUndefined()
  })

  it('bounds the body it downloads for the reading pane', async () => {
    const { fake, connection } = await connected()
    await connection.fetchDetail('INBOX', 5)

    const query = callsTo(fake, 'fetchOne')[0]?.args[1] as { source?: unknown }
    // RFC 4549 §4.6 is a MUST: check the size before downloading the body. An
    // unbounded `source: true` would pull a 30 MB message to show a paragraph.
    expect(query.source).toEqual({ maxLength: 2 * 1024 * 1024 })
    // The generation comes from the SELECT this call just made, not from a
    // STATUS of the mailbox this session has selected.
    expect(callsTo(fake, 'status')).toEqual([])
  })

  it('marks a body the server cut at the cap as truncated', async () => {
    const cut = makeFake({
      // What a capped fetch looks like on the wire: valid headers, a body that
      // stops mid-way, and the full size still reported by RFC822.SIZE — which
      // is the only place the cut is visible at all.
      fetchOne: { ...fetched(5), size: 5 * 1024 * 1024, source: Buffer.from('Subject: Big\n\n只有开头这一段') },
    })
    const connection = createConnection(cut.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    const detail = await connection.fetchDetail('INBOX', 5)
    // Without this the pane would show a short body as if it were the whole one.
    expect(detail?.truncated).toBe(true)
  })

  it('hands the server ALERT text to the caller that can show it', async () => {
    const fake = makeFake()
    const alerts: string[] = []
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30, {
      onAlert: (text) => alerts.push(text),
    })
    await connection.start()

    // RFC 2683 §3.4.11: "Clients must present ALERT text clearly to the user".
    fake.emit('alert', { message: 'quota exceeded', response: 'NO' })
    expect(alerts).toEqual(['quota exceeded'])
    // An event without usable text is nothing a person can be shown.
    fake.emit('alert', { response: 'NO' })
    fake.emit('alert', { message: '', response: 'NO' })
    expect(alerts).toEqual(['quota exceeded'])
  })

  it('downloads a section and refuses a token that is not one', async () => {
    const { fake, connection } = await connected()
    await expect(connection.downloadAttachment('INBOX', 5, '2')).resolves.toMatchObject({ filename: 'report.pdf' })
    expect(callsTo(fake, 'download')[0]?.args).toEqual(['5', '2', { uid: true }])

    // A content id is not an IMAP section: asking for it would earn a BAD
    // response, or — worse — a section that streams the wrong part.
    await expect(connection.downloadAttachment('INBOX', 5, '<logo@example.com>')).resolves.toBeUndefined()
    await expect(connection.downloadAttachment('INBOX', 5, '0')).resolves.toBeUndefined()
    expect(callsTo(fake, 'download')).toHaveLength(1)
  })

  it('lists mailboxes with their counters', async () => {
    const fake = makeFake({
      status: { messages: 12, unseen: 3, uidValidity: 9 },
      list: [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Archive' }],
    })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    await expect(connection.listMailboxes()).resolves.toEqual([
      { accountId: 'acct', path: 'INBOX', specialUse: '\\Inbox', unseen: 3, total: 12 },
      { accountId: 'acct', path: 'Archive', unseen: 3, total: 12 },
    ])
  })

  it('throws a coded offline error on the request path when there is no session', async () => {
    const fake = makeFake()
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await expect(connection.fetchDetail('INBOX', 1)).rejects.toBeInstanceOf(MailOfflineError)
    await expect(connection.fetchDetail('INBOX', 1)).rejects.toMatchObject({ code: 'account_offline' })
  })
})

describe('createConnection lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes to error on a broken connection and reconnects with a backoff until stopped', async () => {
    vi.useFakeTimers()
    const fake = makeFake()
    const folders: string[] = []
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30, {
      onNewMail: (folder) => { folders.push(folder) },
    })
    await connection.start()
    expect(connection.status()).toBe('connected')
    expect(fake.options).toHaveLength(1)

    fake.emit('exists', { path: 'INBOX', count: 2 })
    expect(folders).toEqual(['INBOX'])

    fake.emit('error', new Error('socket hung up'))
    expect(connection.status()).toBe('error')
    expect(connection.lastError()).toContain('socket hung up')

    // The first retry is 5s out, the next 10s, and so on.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fake.options).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.options).toHaveLength(2)
    expect(connection.status()).toBe('connected')
    expect(connection.lastError()).toBeUndefined()

    fake.emit('close')
    expect(connection.status()).toBe('error')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fake.options).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.options).toHaveLength(3)

    await connection.stop()
    expect(connection.status()).toBe('idle')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fake.options).toHaveLength(3)
  })

  it('does not reconnect after stop even when a close arrives later', async () => {
    vi.useFakeTimers()
    const fake = makeFake()
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()
    await connection.stop()
    fake.emit('close')
    fake.emit('error', new Error('late failure'))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fake.options).toHaveLength(1)
    expect(connection.status()).toBe('idle')
  })

  it('survives an unreachable server instead of rejecting start', async () => {
    vi.useFakeTimers()
    const fake = makeFake({ failConnect: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await expect(connection.start()).resolves.toBeUndefined()
    expect(connection.status()).toBe('error')
    expect(connection.lastError()).toContain('ECONNREFUSED')
    await connection.stop()
  })
})

describe('probeAccount', () => {
  const draft = { address: 'user@example.com', imapHost: 'imap.example.com', imapPort: 993, secure: true, password: 'code' }

  it('answers with the mailbox count on a good login', async () => {
    const fake = makeFake({ list: [{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Trash' }] })
    await expect(probeAccount(fake.factory, draft, 30)).resolves.toEqual({ ok: true, mailboxes: 3 })
    expect(callsTo(fake, 'logout')).toHaveLength(1)
    expect(fake.options[0]).toMatchObject({ host: 'imap.example.com', auth: { user: 'user@example.com', pass: 'code' } })
  })

  it('tells a rejected login from an unreachable server', async () => {
    const rejected = makeFake({ failConnect: Object.assign(new Error('Authentication failed'), { authenticationFailed: true }) })
    await expect(probeAccount(rejected.factory, draft, 30)).resolves.toMatchObject({ ok: false, code: 'auth_failed' })

    const unreachable = makeFake({ failConnect: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:993'), { code: 'ECONNREFUSED' }) })
    await expect(probeAccount(unreachable.factory, draft, 30)).resolves.toMatchObject({ ok: false, code: 'network_error' })
  })

  it('reports a TLS upgrade failure as such', async () => {
    const broken = makeFake({ failConnect: Object.assign(new Error('self signed certificate'), { tlsFailed: true }) })
    await expect(probeAccount(broken.factory, draft, 30)).resolves.toMatchObject({ ok: false, code: 'tls_error' })
  })
})

describe('server-pushed changes', () => {
  /** A started connection plus everything the server pushed at it. */
  async function watching(): Promise<{ fake: Fake; flags: MailFlagUpdate[]; expunged: number[]; passes: string[] }> {
    const fake = makeFake()
    const flags: MailFlagUpdate[] = []
    const expunged: number[] = []
    const passes: string[] = []
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30, {
      onFlagsChange: (updates) => { flags.push(...updates) },
      onExpunge: (uids) => { expunged.push(...uids) },
      onNewMail: (folder) => { passes.push(folder) },
    })
    await connection.start()
    return { fake, flags, expunged, passes }
  }

  it('applies a flag change the server volunteered, with no round trip', async () => {
    const { fake, flags, passes } = await watching()

    // RFC 3501 §5.2: the server sends these for the selected mailbox. Nothing was
    // asked for, so the panel can stop calling the message unread at once.
    fake.emit('flags', { path: 'INBOX', uid: 5, flags: new Set(['\\Seen', '\\Flagged']) })

    expect(flags).toEqual([{ uid: 5, seen: true, flagged: true }])
    expect(passes).toEqual([])
  })

  it('falls back to a pass when the server does not name the message', async () => {
    const { fake, flags, passes } = await watching()

    fake.emit('flags', { path: 'INBOX', seq: 3, flags: new Set(['\\Seen']) })

    expect(flags).toEqual([])
    expect(passes).toEqual(['INBOX'])
  })

  it('drops an expunged message the server named, and rescans when it did not', async () => {
    const { fake, expunged, passes } = await watching()

    // QRESYNC reports the UID; a plain EXPUNGE carries only a sequence number,
    // which shifts with every expunge and must never be treated as one.
    fake.emit('expunge', { path: 'INBOX', uid: 7, vanished: true })
    expect(expunged).toEqual([7])

    fake.emit('expunge', { path: 'INBOX', seq: 3, vanished: false })
    expect(passes).toEqual(['INBOX'])
  })

  it('ignores pushes for a mailbox it is not watching', async () => {
    const { fake, flags, passes } = await watching()

    fake.emit('flags', { path: 'Archive', uid: 5, flags: new Set(['\\Seen']) })
    fake.emit('expunge', { path: 'Archive', uid: 6, vanished: true })

    expect(flags).toEqual([])
    expect(passes).toEqual([])
  })
})
