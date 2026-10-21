/**
 * The small, private state the mail plugin remembers between runs.
 *
 * Two things have to survive a restart: how far each folder was scanned, so a
 * reconnect does not walk the whole mailbox again, and which messages were
 * already handed over, so the same message is never handed to an agent twice.
 * Both are kept per account, in one file beside the plugin's own directory, and
 * neither holds a credential — the account records here are exactly what the
 * panel is allowed to see.
 *
 * A damaged file is not an error. The panel has to open so the user can repair
 * the configuration, so anything unreadable falls back to the empty state and
 * `load()` resolves. Writes run through one promise chain, because the panel's
 * buttons fire faster than the disk and two overlapping write-and-rename pairs
 * would keep whichever finished last rather than whichever happened last.
 *
 * @module @free-lzj/dsh-mail/store
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeAccountInput, trustedSendersOf } from './config.ts'
import type {
  AccountState, MailAccount, MailPreferences, MailStateFile, MailSummary, ScanCursor,
} from './types.ts'

/** How many messages one account remembers having triggered something for. */
export const TRIGGER_LEDGER_LIMIT = 500

/**
 * Where the reading pane starts before a person has said otherwise.
 *
 * Remote images load, because a mail is the user's own and the pictures in it are
 * the point of an HTML body. Blocking them is one checkbox away, and the pane
 * then asks per message — see `MailPreferences`.
 */
export const DEFAULT_PREFERENCES: MailPreferences = { loadRemoteImages: true, trustedSenders: [] }

/** One message already handed over, and when. */
interface LedgerEntry {
  readonly key: string
  /** ISO time; the ledger is kept oldest first, which is also how it is trimmed. */
  readonly at: string
}

/**
 * One account's record on disk: its metadata, plus the scan bookkeeping.
 *
 * This is `AccountState` with the account itself attached, so the whole plugin
 * state stays one file and one map keyed by account id — the order of that map
 * is the order the panel lists accounts in.
 */
/**
 * The list the panel last displayed.
 *
 * Kept because the snapshot the panel draws from lives in memory. Without it a
 * restart starts from a blank list until a scan finishes — and since the cursor
 * already points past the mailbox, no scan would produce anything at all. Mature
 * clients treat their local copy as the source of truth and refresh behind it;
 * this is the smallest version of that idea.
 */
export interface CachedSnapshot {
  /** When it was captured, ISO. */
  readonly at: string
  readonly messages: readonly MailSummary[]
}

interface PersistedAccount extends AccountState {
  /** Absent only in a file this plugin did not write. */
  readonly account?: MailAccount
  /** Folder the account was last scanned in, which the panel's tree shows. */
  readonly folder?: string
  /** The rows the panel was showing when this file was last written. */
  readonly messages?: CachedSnapshot
}

/** The whole `state.json`. */
interface PersistedState extends MailStateFile {
  readonly accounts: Readonly<Record<string, PersistedAccount>>
  /** Absent in a file written before the reading pane had preferences. */
  readonly preferences?: {
    readonly loadRemoteImages?: boolean
    readonly trustedSenders?: readonly string[]
  }
}

/** The in-memory form of one account's record. */
interface Entry {
  account: MailAccount | undefined
  folder: string | undefined
  readonly cursors: Map<string, ScanCursor>
  /** Oldest first, trimmed from the front at {@link TRIGGER_LEDGER_LIMIT}. */
  triggered: LedgerEntry[]
  /** The list the panel was showing the last time this account was written. */
  messages: CachedSnapshot | undefined
}

/**
 * The plugin's own state, read from and written to one file.
 *
 * Every mutator resolves once the change is on disk; readers see the change
 * immediately, before the write completes, because the panel must never look
 * stale to the user who just clicked.
 */
export interface MailStore {
  /** Read from disk; a missing or corrupt file yields an empty state (never throws). */
  load(): Promise<void>
  /** Persisted accounts, in insertion order. */
  accounts(): readonly MailAccount[]
  /** Replace the account list and persist. */
  setAccounts(accounts: readonly MailAccount[]): Promise<void>
  /** Cursor for one folder, if any. */
  cursor(accountId: string, folder: string): ScanCursor | undefined
  setCursor(accountId: string, folder: string, cursor: ScanCursor): Promise<void>
  /** Forget one folder's cursor and its entries in the dedupe ledger. */
  forgetFolder(accountId: string, folder: string): Promise<void>
  /** Whether this message already triggered something. */
  isTriggered(accountId: string, key: string): boolean
  markTriggered(accountId: string, key: string): Promise<void>
  /** Folder membership the store learned while scanning (for the panel's mailbox tree). */
  folderFor(accountId: string): string | undefined
  setFolderFor(accountId: string, folder: string): Promise<void>
  /** The rows the panel last displayed, if any. */
  cachedMessages(accountId: string): CachedSnapshot | undefined
  /** Remember the rows the panel is showing, so the next start is not blank. */
  saveMessages(accountId: string, snapshot: CachedSnapshot): Promise<void>
  /** How the reading pane shows remote images. */
  preferences(): MailPreferences
  /** Replace the reading preferences and persist. */
  setPreferences(next: MailPreferences): Promise<void>
  /** Drop everything for one account. */
  forget(accountId: string): Promise<void>
}

/**
 * The identity of one message on one server.
 *
 * `uidValidity` belongs in the key: a server that rebuilds a mailbox restarts
 * UIDs from one, and the same number then means a different message.
 * @param folder - mailbox path the message lives in.
 * @param uidValidity - the mailbox generation the UID was read under.
 * @param uid - the message's UID inside that generation.
 * @returns the ledger key.
 */
export function messageKey(folder: string, uidValidity: number, uid: number): string {
  return `${folder}:${String(uidValidity)}:${String(uid)}`
}

/** Error codes Windows reports when the destination of a rename is briefly held open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Rename onto an existing path, retrying the failures that are only about timing.
 *
 * On Windows `rename` does replace the destination, but only while nothing holds
 * it open — a virus scanner or the search indexer does, briefly and at random.
 * Treating that as fatal would drop a ledger write that the scan loop has
 * already counted as done, and the same message would be handed to the agent a
 * second time, so the call is retried before the failure is surfaced.
 * @param from - the temporary file to move.
 * @param to - the destination it replaces.
 */
async function renameOnto(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code
      if (attempt >= 6 || typeof code !== 'string' || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 20))
    }
  }
}

/** Whether a value is a JSON object rather than an array, `null` or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty, trimmed string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A non-negative integer, the only shape a UID or a UIDVALIDITY may have. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Read one persisted cursor. The folder is the map key, not the field beside it:
 * the key is what every reader looks up by.
 * @param folder - the cursor's key.
 * @param value - the stored value.
 * @returns the cursor, or undefined when the record cannot be trusted.
 */
function parseCursor(folder: string, value: unknown): ScanCursor | undefined {
  if (!isRecord(value)) return undefined
  const uidValidity = count(value.uidValidity)
  const lastUid = count(value.lastUid)
  return uidValidity === undefined || lastUid === undefined ? undefined : { folder, uidValidity, lastUid }
}

/**
 * Read one persisted account record.
 *
 * The stored account goes back through the same normalizer the panel's POST
 * body does, so a hand-edited file cannot smuggle in a record the routes would
 * have refused.
 * @param id - the account id, which is the record's key.
 * @param value - the stored account.
 * @returns the account, or undefined when it is not one.
 */
function parseAccount(id: string, value: unknown): MailAccount | undefined {
  if (!isRecord(value)) return undefined
  const result = normalizeAccountInput({ ...value, id })
  return result.ok ? { ...result.value, id } : undefined
}

/** Read the ledger, dropping entries that are not a key and a time. */
function parseLedger(value: unknown): LedgerEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((item): LedgerEntry[] => {
      if (!isRecord(item)) return []
      const key = text(item.key)
      return key === undefined || typeof item.at !== 'string' ? [] : [{ key, at: item.at }]
    })
    .slice(-TRIGGER_LEDGER_LIMIT)
}

/**
 * Read a persisted snapshot.
 *
 * Rows are checked only far enough to be drawn: a hand-edited file is not worth
 * refusing the whole snapshot over, and dropping a malformed row is cheaper than
 * rendering it.
 * @param value - the stored snapshot.
 * @returns the snapshot, or undefined when it cannot be trusted at all.
 */
function parseSnapshot(value: unknown): CachedSnapshot | undefined {
  if (!isRecord(value) || typeof value.at !== 'string' || !Array.isArray(value.messages)) return undefined
  const messages = value.messages
    .filter(item => isRecord(item) && typeof item.uid === 'number' && typeof item.folder === 'string') as MailSummary[]
  return { at: value.at, messages }
}

/**
 * Read the persisted reading preferences.
 *
 * A file that predates the setting keeps the default rather than flipping to
 * blocked: "the user never chose" and "the user chose off" have to stay
 * distinguishable, and only an explicit `false` is the latter.
 * @param value - the stored `preferences`, whatever it turned out to be.
 * @returns the preferences to run with.
 */
function parsePreferences(value: unknown): MailPreferences {
  if (!isRecord(value)) return DEFAULT_PREFERENCES
  return {
    loadRemoteImages: value.loadRemoteImages === false ? false : true,
    trustedSenders: trustedSendersOf(value.trustedSenders),
  }
}

/**
 * Open the store behind one file.
 * @param options - `path` is the `state.json` to own; nothing else is read from
 * the environment, so a test can point it at a temporary directory.
 * @returns the store.
 */
export function createStore(options: { readonly path: string }): MailStore {
  const path = options.path

  /** Accounts by id, in insertion order. */
  let entries = new Map<string, Entry>()

  /** Reading preferences; one record for the whole plugin, not one per account. */
  let preferences: MailPreferences = DEFAULT_PREFERENCES

  /** The tail of the write chain: each write starts after the previous one ended. */
  let tail: Promise<unknown> = Promise.resolve()

  /** Run one write after every write queued before it, success or failure. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    // The chain must survive a failed write, or every later one is skipped.
    tail = run.catch(() => undefined)
    return run
  }

  /** The account's record, created empty when it is the first write for it. */
  function entryFor(accountId: string): Entry {
    const existing = entries.get(accountId)
    if (existing !== undefined) return existing
    const created: Entry = { account: undefined, folder: undefined, cursors: new Map(), triggered: [], messages: undefined }
    entries.set(accountId, created)
    return created
  }

  /**
   * Write the whole state.
   *
   * The file is written beside its destination and renamed onto it, so a reader
   * never sees half a file and an interrupted write leaves the previous one. The
   * mode is set twice because a rename replaces the destination with the
   * temporary file's mode, which only exists when the temporary file was created.
   */
  async function persist(): Promise<void> {
    const accounts: Record<string, PersistedAccount> = {}
    for (const [id, entry] of entries) {
      const cursors: Record<string, ScanCursor> = {}
      for (const [folder, cursor] of entry.cursors) cursors[folder] = cursor
      accounts[id] = {
        cursors,
        triggered: entry.triggered.map(item => ({ ...item })),
        ...(entry.account === undefined ? {} : { account: entry.account }),
        ...(entry.folder === undefined ? {} : { folder: entry.folder }),
        ...(entry.messages === undefined ? {} : { messages: entry.messages }),
      }
    }
    const file: PersistedState = { version: 1, accounts, preferences }
    const temporary = `${path}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await renameOnto(temporary, path)
    // ponytail: best effort only, and Windows ignores it; the plugin's directory
    // is the real boundary. Tighten with an absolute ACL if the platform needs one.
    await chmod(path, 0o600).catch(() => undefined)
  }

  async function load(): Promise<void> {
    entries = new Map()
    preferences = DEFAULT_PREFERENCES
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(parsed) || parsed.version !== 1) return
    // Before the account guard: the reading preferences are not account state,
    // and a file whose account map is unreadable still knows how to show mail.
    preferences = parsePreferences(parsed.preferences)
    if (!isRecord(parsed.accounts)) return
    for (const [id, stored] of Object.entries(parsed.accounts)) {
      if (!isRecord(stored)) continue
      const cursors = new Map<string, ScanCursor>()
      if (isRecord(stored.cursors)) {
        for (const [folder, value] of Object.entries(stored.cursors)) {
          const cursor = parseCursor(folder, value)
          if (cursor !== undefined) cursors.set(folder, cursor)
        }
      }
      entries.set(id, {
        account: parseAccount(id, stored.account),
        folder: text(stored.folder),
        cursors,
        triggered: parseLedger(stored.triggered),
        messages: parseSnapshot(stored.messages),
      })
    }
  }

  async function setAccounts(next: readonly MailAccount[]): Promise<void> {
    const replaced = new Map<string, Entry>()
    for (const account of next) {
      const existing = entries.get(account.id)
      replaced.set(account.id, existing === undefined
        ? { account, folder: undefined, cursors: new Map(), triggered: [], messages: undefined }
        : { ...existing, account })
    }
    entries = replaced
    await serialize(persist)
  }

  async function setCursor(accountId: string, folder: string, cursor: ScanCursor): Promise<void> {
    entryFor(accountId).cursors.set(folder, { folder, uidValidity: cursor.uidValidity, lastUid: cursor.lastUid })
    await serialize(persist)
  }

  async function markTriggered(accountId: string, key: string): Promise<void> {
    const entry = entryFor(accountId)
    if (!entry.triggered.some(item => item.key === key)) {
      entry.triggered.push({ key, at: new Date().toISOString() })
      if (entry.triggered.length > TRIGGER_LEDGER_LIMIT) {
        entry.triggered.splice(0, entry.triggered.length - TRIGGER_LEDGER_LIMIT)
      }
    }
    await serialize(persist)
  }

  /**
   * Forget one folder's cursor and its entries in the dedupe ledger.
   *
   * A server that rebuilds a mailbox restarts its UIDs, so both records name
   * messages that no longer exist — and a stale UID can end up addressing a
   * different message entirely. The ledger keys carry the folder first (see
   * {@link messageKey}), which is why they can be dropped by prefix.
   * @param accountId - the account whose folder changed.
   * @param folder - the mailbox path to forget.
   */
  async function forgetFolder(accountId: string, folder: string): Promise<void> {
    const entry = entryFor(accountId)
    const prefix = `${folder}:`
    entry.cursors.delete(folder)
    entry.triggered = entry.triggered.filter(item => !item.key.startsWith(prefix))
    await serialize(persist)
  }

  async function setFolderFor(accountId: string, folder: string): Promise<void> {
    entryFor(accountId).folder = folder
    await serialize(persist)
  }

  /**
   * Replace the remembered list.
   *
   * Written with the rest of the account's record rather than to a file of its
   * own: two files would be two chances to disagree about what the panel showed.
   * The caller writes this once per pass, not once per changed row.
   * @param accountId - the account the rows belong to.
   * @param snapshot - the rows, and when they were read.
   */
  async function saveMessages(accountId: string, snapshot: CachedSnapshot): Promise<void> {
    entryFor(accountId).messages = snapshot
    await serialize(persist)
  }

  async function setPreferences(next: MailPreferences): Promise<void> {
    // Through the same normalizer the panel's POST goes through, so a caller
    // cannot write a whitelist entry the routes would have refused.
    preferences = {
      loadRemoteImages: next.loadRemoteImages !== false,
      trustedSenders: trustedSendersOf(next.trustedSenders),
    }
    await serialize(persist)
  }

  async function forget(accountId: string): Promise<void> {
    entries.delete(accountId)
    await serialize(persist)
  }

  return {
    load,
    accounts: () => [...entries.values()].flatMap(entry => (entry.account === undefined ? [] : [entry.account])),
    setAccounts,
    cursor: (accountId, folder) => entries.get(accountId)?.cursors.get(folder),
    setCursor,
    forgetFolder,
    isTriggered: (accountId, key) => entries.get(accountId)?.triggered.some(item => item.key === key) ?? false,
    markTriggered,
    folderFor: accountId => entries.get(accountId)?.folder,
    setFolderFor,
    cachedMessages: accountId => entries.get(accountId)?.messages,
    saveMessages,
    preferences: () => preferences,
    setPreferences,
    forget,
  }
}
