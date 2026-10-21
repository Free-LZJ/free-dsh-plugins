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
  MAX_BODY_PART_BYTES, MailOfflineError, createConnection, layoutOf, probeAccount, scanFolder,
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
   * What the session's own SELECT view reports, which is where a scan reads the
   * counters and the generation from. `exists` defaults to the size of
   * `mailbox`; `uidValidity` and `uidNext` are absent unless scripted.
   *
   * `uidNext` is scripted to the value a long-lived connection would be holding:
   * a snapshot from its last SELECT, not the server's current number.
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
  /**
   * What a `bodyParts` FETCH answers, keyed by the section requested.
   *
   * The reading pane asks for the parts its body is made of in a second command,
   * so a script has to be able to answer the head and the parts differently. A
   * section the script does not name is one the server did not answer for.
   */
  readonly parts?: Readonly<Record<string, string | Buffer>>
  /** Content the download answers with, or false for "the part is not there". */
  readonly download?: { filename?: string; contentType?: string } | false
  /**
   * What `CREATE` answers, in the shapes imapflow actually returns them:
   * a created mailbox, the server's `ALREADYEXISTS` answer (which imapflow
   * reports as `created: false` rather than as a throw), `undefined` for a
   * session that is not authenticated, or a thrown command failure.
   */
  readonly create?: { readonly path?: string; readonly created?: boolean } | { readonly throws: unknown } | 'not-authenticated'
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
      async mailboxCreate(path): Promise<{ path: string; created?: boolean } | undefined> {
        calls.push({ method: 'mailboxCreate', args: [path] })
        const scripted = script.create
        if (scripted === undefined) return { path, created: true }
        if (scripted === 'not-authenticated') return undefined
        if ('throws' in scripted) throw scripted.throws
        return { path: scripted.path ?? path, ...(scripted.created === undefined ? {} : { created: scripted.created }) }
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
        const wanted = (query as { bodyParts?: readonly { key?: string }[] } | null)?.bodyParts
        if (Array.isArray(wanted)) {
          // The reading pane's second command: only the sections it named come
          // back, keyed the way imapflow keys them, and the answer is a different
          // shape from a head — so a scripted head never stands in for it.
          const bodyParts = new Map<string, Buffer>()
          for (const one of wanted) {
            const value = one.key === undefined ? undefined : script.parts?.[one.key]
            if (value !== undefined) bodyParts.set(one.key as string, Buffer.from(value))
          }
          return { ...fetched(Number(seq)), bodyParts }
        }
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

  it('sees mail the session UIDNEXT has not caught up with', async () => {
    // The bug this pass exists for: a connection that has been open since before
    // the mail arrived holds a UIDNEXT from its last SELECT. imapflow only
    // advances that number on a SELECT, a STATUS or a FETCH that carries a UID,
    // and the EXISTS a new message sends to an idling session does none of those
    // — so gating on it (or bounding the SEARCH with it) hides exactly the mail
    // the pass is looking for.
    const fake = makeFake({ mailbox: [10, 11], mailboxState: { uidNext: 11, exists: 2, uidValidity: 7 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 11, knownUidValidity: 7 }))

    const newMail = callsTo(fake, 'search').find(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(newMail?.args[0]).toEqual({ uid: '11:*' })
    expect(outcome.messages.map(message => message.summary.uid)).toEqual([11])
    expect(outcome.maxUid).toBe(11)
  })

  it('reads the open range and fetches nothing when no UID is at the cursor', async () => {
    const fake = makeFake({
      mailbox: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      mailboxState: { uidNext: 10, exists: 9, uidValidity: 7 },
    })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 10, knownUidValidity: 7 }))

    // `UID SEARCH 10:*` always matches the last message of a non-empty mailbox
    // (RFC 3501 §6.4.8 Note), so the search is sent and its answer is read
    // through the `uid >= from` filter rather than through its emptiness.
    const newMail = callsTo(fake, 'search').filter(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(newMail).toHaveLength(1)
    expect(newMail[0]?.args[0]).toEqual({ uid: '10:*' })
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
    expect(outcome.messages).toEqual([])
    // The cursor may not advance: 10 means "start at 10", and nothing was read.
    expect(outcome.maxUid).toBe(9)
    // The rest of the answer still comes back, counters included, or the folder
    // tree would go blank on every quiet poll.
    expect(outcome.counters).toEqual({ total: 9, unseen: 9 })
    expect(outcome.uidValidity).toBe(7)
    expect(callsTo(fake, 'release')).toHaveLength(1)
  })

  it('filters the open range down to the UIDs at or above the cursor', async () => {
    // 3 and 4 sit below the cursor: the open range hands them back, and the
    // client-side filter is what keeps them out of the batch.
    const fake = makeFake({ mailbox: [3, 4, 5, 6, 7, 8, 9], mailboxState: { exists: 7, uidValidity: 7 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ fromUid: 5, knownUidValidity: 7 }))

    const newMail = callsTo(fake, 'search').find(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    // `5:*`, not `5:9`: only the server knows where its UID space ends, and the
    // UIDNEXT this session holds is a snapshot, not that number.
    expect(newMail?.args[0]).toEqual({ uid: '5:*' })
    expect(outcome.maxUid).toBe(9)
    expect(callsTo(fake, 'fetch')[0]?.args[0]).toEqual([5, 6, 7, 8, 9])
  })

  it('reads a backwards window as the newest page below its upper bound', async () => {
    const fake = makeFake({ mailbox: [1, 2, 3, 4, 5, 6, 7, 8, 9], mailboxState: { exists: 9, uidValidity: 7 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ beforeUid: 8, maxMessages: 3 }))

    // `1:7`, not `1:*`: closing the range is what makes the pass walk backwards.
    const newMail = callsTo(fake, 'search').find(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(newMail?.args[0]).toEqual({ uid: '1:7' })
    // The page closest to the bound — 5, 6, 7 — not the oldest three in the folder.
    expect(callsTo(fake, 'fetch')[0]?.args[0]).toEqual([5, 6, 7])
    expect(outcome.messages.map(one => one.summary.uid)).toEqual([5, 6, 7])
  })

  it('answers an inverted window without asking the server for it', async () => {
    const fake = makeFake({ mailbox: [1, 2, 3], mailboxState: { exists: 3, uidValidity: 7 } })
    const outcome = await scanFolder(fake.factory({}), scanOptions({ beforeUid: 1 }))

    // `UID SEARCH 1:0` is a malformed range rather than an empty one, and some
    // servers answer it with BAD; having reached the oldest message is not an error.
    const ranged = callsTo(fake, 'search').filter(one => (one.args[0] as { uid?: unknown }).uid !== undefined)
    expect(ranged).toHaveLength(0)
    expect(callsTo(fake, 'fetch')).toHaveLength(0)
    expect(outcome.messages).toEqual([])
    // The counters still come back, or the folder tree would blink to zero on
    // every page that happens to be empty.
    expect(outcome.counters).toEqual({ total: 3, unseen: 3 })
  })

  it('leaves the cursor alone when SEARCH fails', async () => {
    const fake = makeFake({ search: false, mailboxState: { exists: 400, uidValidity: 7 } })
    const client = fake.factory({})
    const outcome = await scanFolder(client, scanOptions({ fromUid: 11, knownUidValidity: 7 }))

    expect(outcome.messages).toEqual([])
    // 11 means "start at 11"; a failed SEARCH must not claim 11 was processed.
    expect(outcome.maxUid).toBe(10)
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

describe('layoutOf', () => {
  /** A structure node, with the fields a real BODYSTRUCTURE carries. */
  const node = (fields: Record<string, unknown>): Record<string, unknown> => fields

  it('reads a multipart message into the parts a reader needs', () => {
    const layout = layoutOf(node({
      type: 'multipart/mixed',
      childNodes: [
        node({
          type: 'multipart/alternative',
          childNodes: [
            node({ part: '1.1', type: 'text/plain', parameters: { charset: 'utf-8' } }),
            node({ part: '1.2', type: 'text/html', parameters: { charset: 'utf-8' } }),
          ],
        }),
        node({ part: '2', type: 'application/pdf', size: 2048, disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } }),
      ],
    }))

    expect(layout.text.map(plan => plan.section)).toEqual(['1.1'])
    expect(layout.html.map(plan => plan.section)).toEqual(['1.2'])
    expect(layout.inline).toEqual([])
    expect(layout.attachments).toEqual([
      { part: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 2048 },
    ])
  })

  it('addresses a non-multipart message as part 1, which is what the server calls it', () => {
    // RFC 3501 §6.4.5: a message that is not multipart has exactly one part, and
    // the structure carries no number for it. `1` is the section on the wire and
    // the shape the download route's own check accepts.
    const layout = layoutOf(node({ type: 'text/html', parameters: { charset: 'gb18030' }, size: 700 }))
    expect(layout.html).toEqual([
      { section: '1', type: 'text/html', parameters: { charset: 'gb18030' }, size: 700, root: true },
    ])
    expect(layout.attachments).toEqual([])
  })

  it('lists a part the HTML names as both a picture and a file', () => {
    const layout = layoutOf(node({
      type: 'multipart/related',
      childNodes: [
        node({ part: '1', type: 'text/html', parameters: { charset: 'utf-8' } }),
        node({ part: '2', type: 'image/png', id: '<logo@example.com>', size: 30, disposition: 'inline', dispositionParameters: { filename: 'logo.png' } }),
      ],
    }))
    expect(layout.inline).toEqual([{
      section: '2', type: 'image/png', size: 30, cid: '<logo@example.com>',
    }])
    // The pane draws it *and* offers it, which is what the parser's own list did.
    expect(layout.attachments).toEqual([
      { part: '2', filename: 'logo.png', contentType: 'image/png', size: 30 },
    ])
  })

  it('takes an attached text file for a file, not for the message', () => {
    // `Content-Disposition: attachment` on a `text/plain` part is a .txt the
    // sender attached; handing it over as the body would show a file as the mail.
    const layout = layoutOf(node({
      type: 'multipart/mixed',
      childNodes: [
        node({ part: '1', type: 'text/plain', parameters: { charset: 'utf-8' } }),
        node({ part: '2', type: 'text/plain', size: 12, disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } }),
      ],
    }))
    expect(layout.text.map(plan => plan.section)).toEqual(['1'])
    expect(layout.attachments).toEqual([
      { part: '2', filename: 'notes.txt', contentType: 'text/plain', size: 12 },
    ])
  })

  it('leaves an attached mail at its wrapper instead of walking into it', () => {
    // A message/rfc822 part *contains* a message with its own text part; reading
    // it as this message's body would show the attached mail as the mail.
    const layout = layoutOf(node({
      type: 'multipart/mixed',
      childNodes: [
        node({ part: '1', type: 'text/plain' }),
        node({
          part: '2',
          type: 'message/rfc822',
          size: 900,
          disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [node({ part: '2', type: 'text/plain' })],
        }),
      ],
    }))
    expect(layout.text.map(plan => plan.section)).toEqual(['1'])
    expect(layout.attachments).toEqual([
      { part: '2', filename: 'forwarded.eml', contentType: 'message/rfc822', size: 900 },
    ])
  })

  it('has nothing to fetch for a structure the server did not describe', () => {
    expect(layoutOf(undefined)).toEqual({ text: [], html: [], inline: [], attachments: [] })
    expect(layoutOf(null)).toEqual({ text: [], html: [], inline: [], attachments: [] })
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

  it('puts the watched folder back after paging through another one', async () => {
    const { fake, connection } = await connected()
    const before = callsTo(fake, 'getMailboxLock').length
    await connection.scan({ folder: 'Archive', fromUid: 1, knownUidValidity: 0, maxMessages: 10 })

    // IDLE only announces the selected mailbox (RFC 2177 §3), and imapflow keeps
    // whatever the last lock selected — so a page in another folder would leave
    // the account quietly watching the wrong mailbox until something else
    // happened to switch it back.
    const after = callsTo(fake, 'getMailboxLock').slice(before).map(call => call.args[0])
    expect(after).toEqual(['Archive', 'INBOX'])
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
    const { connection } = await connected({ parts: { 1: 'Hello   mail 5\n' } })
    const detail = await connection.fetchDetail('INBOX', 5)
    expect(detail?.subject).toBe('Message 5')
    // The body is the part the server answered with, and nothing else.
    expect(detail?.text).toContain('Hello   mail 5')
    expect(detail?.truncated).toBe(false)

    const missing = makeFake({ fetchOne: false })
    const gone = createConnection(missing.factory, accountOf(), 'secret-code', 30)
    await gone.start()
    await expect(gone.fetchDetail('INBOX', 5)).resolves.toBeUndefined()
  })

  it('reads a message by asking for its parts, never for the message', async () => {
    const { fake, connection } = await connected({ parts: { 1: 'the body' } })
    await connection.fetchDetail('INBOX', 5)

    const asked = callsTo(fake, 'fetchOne')
    expect(asked).toHaveLength(2)
    // The head: everything about the message, none of its bytes.
    const head = asked[0]?.args[1] as { source?: unknown; bodyStructure?: unknown }
    expect(head.source).toBeUndefined()
    expect(head.bodyStructure).toBe(true)
    // The parts: one section, capped, because a byte range has to be asked for
    // before the bytes are (RFC 4549 §4.6) — and this is the only cap left.
    expect((asked[1]?.args[1] as { bodyParts?: unknown }).bodyParts)
      .toEqual([{ key: '1', start: 0, maxLength: MAX_BODY_PART_BYTES }])
    // The generation comes from the SELECT this call just made, not from a
    // STATUS of the mailbox this session has selected.
    expect(callsTo(fake, 'status')).toEqual([])
  })

  it('opens a message with a big attachment without fetching the attachment', async () => {
    // The reported bug, at the size that produced it: a 70 KB body behind a 3 MB
    // PDF used to be fetched as one capped source, came back cut, and the pane
    // announced a truncated body it had actually received in full.
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' } },
        { part: '2', type: 'application/pdf', encoding: 'base64', size: 3 * 1024 * 1024, disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } },
      ],
    }
    const { fake, connection } = await connected({
      fetchOne: { ...fetched(5), size: 3 * 1024 * 1024 + 70_000, bodyStructure: structure },
      parts: { 1: '正文只有这一段' },
    })
    const detail = await connection.fetchDetail('INBOX', 5)

    expect(detail?.text).toContain('正文只有这一段')
    // The notice used to fire here, and the message had not been cut at all.
    expect(detail?.truncated).toBe(false)
    // The attachment is listed from the structure, with the section the download
    // route will use, and without a byte of it having crossed the wire.
    expect(detail?.attachments).toEqual([
      { part: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 3 * 1024 * 1024 },
    ])
    expect(detail?.hasAttachments).toBe(true)
    const asked = callsTo(fake, 'fetchOne')
    expect((asked[1]?.args[1] as { bodyParts?: readonly { key: string }[] }).bodyParts?.map(one => one.key))
      .toEqual(['1'])
  })

  it('says so when a body part itself came back at the cap', async () => {
    const cut = makeFake({
      fetchOne: { ...fetched(5), bodyStructure: { part: '1', type: 'text/html', encoding: 'base64', size: MAX_BODY_PART_BYTES + 1 } },
      parts: { 1: '<p>只有开头这一段</p>' },
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

  it('creates a folder and answers with the path the server reports', async () => {
    const fake = makeFake({ create: { path: 'INBOX.推广' } })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()

    // imapflow adds the namespace prefix and joins path segments itself, so the
    // path it echoes back is the one a later MOVE has to use.
    await expect(connection.mailboxCreate('推广')).resolves.toEqual({ ok: true, path: 'INBOX.推广' })
    expect(callsTo(fake, 'mailboxCreate')[0]?.args).toEqual(['推广'])
  })

  it('treats a folder that already exists as a success', async () => {
    // RFC 5530 `ALREADYEXISTS` is what a server answers for a folder that is
    // already there; imapflow turns it into `created: false` rather than a
    // throw. "Make sure it exists" asked exactly that.
    const fake = makeFake({ create: { created: false } })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()

    await expect(connection.mailboxCreate('推广')).resolves.toEqual({ ok: true, path: '推广' })
  })

  it('reports a refused CREATE as imap_rejected rather than throwing', async () => {
    const fake = makeFake({ create: { throws: new Error('Mailbox name is not allowed') } })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()

    await expect(connection.mailboxCreate('bad name'))
      .resolves.toMatchObject({ ok: false, code: 'imap_rejected' })
  })

  it('reports a dropped connection during CREATE as account_offline', async () => {
    const fake = makeFake({ create: { throws: Object.assign(new Error('Connection not available'), { code: 'NoConnection' }) } })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()

    await expect(connection.mailboxCreate('推广'))
      .resolves.toMatchObject({ ok: false, code: 'account_offline' })
  })

  it('answers offline when there is no session, without throwing', async () => {
    const fake = makeFake()
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await expect(connection.mailboxCreate('推广'))
      .resolves.toMatchObject({ ok: false, code: 'account_offline' })
    expect(callsTo(fake, 'mailboxCreate')).toEqual([])
  })

  it('answers offline when the session is not authenticated', async () => {
    // imapflow returns undefined instead of throwing when the precondition
    // (an authenticated session) is not met.
    const fake = makeFake({ create: 'not-authenticated' })
    const connection = createConnection(fake.factory, accountOf(), 'secret-code', 30)
    await connection.start()

    await expect(connection.mailboxCreate('推广'))
      .resolves.toMatchObject({ ok: false, code: 'account_offline' })
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
