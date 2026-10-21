/**
 * Mail for DSH — Host half.
 *
 * This is the wiring: it owns the long-lived things the panel cannot (an IMAP
 * connection per account, the scan loop, the snapshot the routes read) and
 * hands the rest of the work to modules that do not know about each other.
 *
 * Two rules shape the file. First, **nothing long-lived lives in the browser
 * half** — the main panel is unmounted the moment another one is selected, so
 * connections, timers and triggers all belong here. Second, a message is handed
 * over **once**: the ledger is written before the trigger runs, so a trigger
 * that fails cannot be replayed into a second session later.
 *
 * @module @free-lzj/dsh-mail
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge the routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  accountIdFor, readPassword, removePassword, testAccount, writePassword,
  type CredentialsLike, type ProbeFn,
} from './accounts.ts'
import {
  DEFAULT_CONFIG, normalizeAccountInput, normalizeAction, normalizeDraft,
  normalizePreferences, normalizeTrigger, senderKey, withTrustedSender,
} from './config.ts'
import {
  createConnection, imapFactoryFor, probeAccount, WATCHED_FOLDER,
  type ImapFactory, type MailConnection, type MailFlagUpdate,
} from './imap.ts'
import { promptBody } from './rules.ts'
import { createStore, messageKey, type MailStore } from './store.ts'
import {
  createTriggerer, presetChoices, resolveTrigger, triggerAvailability, workbenchAvailable,
  type Triggerer, type TriggerHost,
} from './trigger.ts'
import { registerRoutes, type AttachmentPayload, type RouteHost } from './routes.ts'
import type {
  AccountStatus, ConsoleNoticeLike, DraftAccount, MailAccount, MailAction, MailDetail, MailReceivedPayload,
  MailService, MailState, MailSummary, MailboxView, NormalizedMessage, PresetChoice, RouteResult, ScanCursor,
  TriggerConfig,
} from './types.ts'

export * from './paths.ts'
export * from './types.ts'

// Type-only: the two extension points other plugins meet — the `ctx.mail`
// service a consumer reads, and the `mail/received` event a triage engine
// listens on. Both are declared here rather than in `types.ts` because they
// merge into cordis, and only the Host half has any business doing that.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The mail I/O service, when this plugin is mounted.
     *
     * Optional on purpose: a deployment without the mail plugin simply has no
     * mail, and a consumer must treat that as a normal state (see
     * `rules/design-patterns.md` on optional dependencies) rather than as a
     * missing dependency it can install its way out of.
     */
    mail?: MailService
  }
  interface Events {
    /**
     * A new message arrived on a configured account.
     *
     * Emitted instead of acted upon: which rules exist and what they do belongs
     * to the triage engine (`@free-lzj/dsh-mailflow`), and mail only owns "a
     * message arrived". The dedupe ledger is written **before** this is
     * dispatched, so a listener that throws does not cause a replay.
     */
    'mail/received'(payload: MailReceivedPayload): void
  }
}

/**
 * The only folder the scan loop watches; other folders are listed but not scanned.
 *
 * Declared in `imap.ts`, which is where the connection SELECTs it: a mailbox
 * only announces changes while it is the selected one, so the constant and the
 * SELECT have to agree.
 */
export { WATCHED_FOLDER }

/**
 * Hard ceiling on one account's in-memory window, across every folder.
 *
 * `maxListMessages` is one *page*: what a scan fetches, and what `/state` first
 * draws. It is deliberately not a ceiling, because the whole point of "load
 * more" is to grow past it. This is the ceiling instead, and it is a memory and
 * bandwidth bound rather than a correctness one: every revision change
 * re-serialises the whole list to the panel, so 2000 rows is a few hundred KB
 * per change — past that, polling stops being free.
 */
const MAX_SNAPSHOT_MESSAGES = 2000

/**
 * Identity of one snapshot row.
 *
 * A UID is only unique *inside* one mailbox (RFC 3501 §2.3.1.1), so keying by
 * UID alone would let an INBOX row and a Sent row with the same number
 * overwrite each other as soon as a second folder is loaded.
 * @param message - the row to key.
 * @returns a key unique across folders and accounts of one account's window.
 */
function snapshotKey(message: MailSummary): string {
  return `${message.folder}\u0000${String(message.uid)}`
}

/**
 * Shortest gap between two panel-driven scans of one account.
 *
 * This is the real latency of "I read a message on my phone, why is it still bold
 * here". Measured against the live server: it does not volunteer flag changes to
 * an idle connection (RFC 3501 §5.2 is a SHOULD, and QQ skips it), and it has no
 * CONDSTORE to ask "what changed since…" either — so the only way to notice is to
 * look. A look is one FETCH of the flags of the rows on screen, a few KB, and it
 * only happens while somebody has the panel open.
 */
const PANEL_REFRESH_MIN_MS = 10_000

/**
 * Where this plugin keeps its state, following the same resolution as the rest
 * of the family: `$DSH_HOME`, else `~/.dsh`.
 * @returns absolute path of the dsh home directory.
 */
function mailHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * The panel document inside this package.
 *
 * The file sits at the package root, while this module is bundled either at
 * `lib/index.js` or, before bundling, at `lib/types/index.js` — so both
 * candidate roots are tried rather than assuming one depth.
 * @returns absolute path to the panel document.
 */
function panelDocumentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, '..', 'assets', 'panel.html')
  return existsSync(bundled) ? bundled : join(here, '..', '..', 'assets', 'panel.html')
}

/** One account's connection state, as the panel shows it. */
interface Status {
  readonly status: AccountStatus
  readonly error?: string
}

/**
 * Mount the mail plugin.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: Context): void {
  const store: MailStore = createStore({ path: join(mailHome(), 'mail', 'state.json') })
  const connections = new Map<string, MailConnection>()
  const snapshots = new Map<string, MailSummary[]>()
  const mailboxes = new Map<string, MailboxView[]>()
  const statuses = new Map<string, Status>()
  /**
   * The last ALERT each account's server sent.
   *
   * RFC 2683 §3.4.11 makes presenting it the client's job, and it is the one
   * server message that is explicitly about the human rather than the protocol:
   * a quota warning, a shutdown notice. It is kept per account and read by
   * `state()` below, because a connection's own event handler cannot render.
   */
  const alerts = new Map<string, string>()
  /** When each account's remembered list was read, for the panel's "from cache" note. */
  const cacheAt = new Map<string, string>()
  /** Why the last scan of an account failed, kept until one succeeds. */
  const syncErrors = new Map<string, string>()
  /** Where the last scan pass got to, so a stalled one is visible instead of silent. */
  const stages = new Map<string, string>()
  const uidValidityOf = new Map<string, number>()
  const scanning = new Map<string, Promise<void>>()
  const lastScanAt = new Map<string, number>()
  let fallback: NodeJS.Timeout | undefined
  let stopping = false

  /** The credentials service, or undefined when the host did not mount it. */
  const credentials = (): CredentialsLike | undefined =>
    ctx.get('credentials') as CredentialsLike | undefined

  /**
   * The trigger host, read fresh each time so a service that appears later is
   * picked up. Missing services are left absent — `triggerAvailability` and the
   * readiness gate turn that into a visible "unavailable", never a crash.
   */
  const triggerHost = (): TriggerHost => ({
    permissions: ctx.get('permissionPresets'),
    agentPresets: ctx.get('agentPresets'),
    workspaces: ctx.get('workspaceRegistry'),
    agents: ctx.get('agents'),
    titles: ctx.get('sessionTitle'),
    sessions: ctx.get('sessionController'),
    defaultModel: ctx.get('agentDefaultModel'),
    // Read fresh for the same reason as the rest: the workbench is an optional
    // plugin whose Loader row may come before or after this one.
    console: ctx.get('console') as ConsoleNoticeLike | undefined,
    log: (message: string) => ctx.logger.info(message),
  }) as unknown as TriggerHost

  /** A factory bound to one account's credentials, for the out-of-band scan path. */
  const factoryFor = (account: MailAccount, password: string): ImapFactory =>
    imapFactoryFor(account, password, DEFAULT_CONFIG.imapTimeoutSeconds)

  const probe: ProbeFn = (draft: DraftAccount, timeoutSeconds: number) =>
    probeAccount(
      imapFactoryFor(
        { ...draft, id: 'probe', name: draft.address, provider: 'custom', trigger: { mode: 'panel', filters: {} } },
        draft.password,
        timeoutSeconds,
      ),
      draft,
      timeoutSeconds,
    )

  /**
   * Bumped whenever anything the panel draws changes.
   *
   * The panel polls `/state` every couple of seconds and hands back the revision
   * it already holds; when this has not moved, the route answers with a few dozen
   * bytes instead of re-serialising the whole list.
   */
  let revision = 0

  /** Note that the panel's view changed. */
  function touch(): void {
    revision += 1
  }

  /** Remember what an account's connection is doing. */
  function setStatus(accountId: string, status: AccountStatus, error?: string): void {
    statuses.set(accountId, error === undefined ? { status } : { status, error })
    touch()
  }

  /**
   * Fold freshly scanned messages into the snapshot, newest first.
   *
   * Ordered by date rather than by UID: `/state` draws by date, and once more
   * than one folder is in the window a UID ordering would trim whichever folder
   * happens to use the lowest numbers. The trim is the ceiling, not the page
   * size — see {@link MAX_SNAPSHOT_MESSAGES}.
   * @param accountId - the account whose window grows.
   * @param incoming - the rows the server just returned.
   * @returns how many rows were not already held, so "load more" can tell the
   * panel whether its page brought anything.
   */
  function mergeSnapshot(accountId: string, incoming: readonly MailSummary[]): number {
    const byKey = new Map<string, MailSummary>()
    for (const message of snapshots.get(accountId) ?? []) byKey.set(snapshotKey(message), message)
    let added = 0
    for (const message of incoming) {
      const key = snapshotKey(message)
      if (!byKey.has(key)) added += 1
      byKey.set(key, message)
    }
    snapshots.set(
      accountId,
      [...byKey.values()]
        .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
        .slice(0, MAX_SNAPSHOT_MESSAGES),
    )
    touch()
    return added
  }

  /** Forget one folder's rows, leaving the account's other folders alone. */
  function dropFolderRows(accountId: string, folder: string): void {
    snapshots.set(accountId, (snapshots.get(accountId) ?? []).filter(message => message.folder !== folder))
    touch()
  }

  /**
   * Fold re-read flags into the snapshot.
   *
   * Only `seen` and `flagged` move: the rest of a row was already fetched, and
   * rebuilding it here would risk replacing a newer summary with an older one.
   * @param accountId - the account whose rows changed.
   * @param folder - the mailbox those flags describe; a UID means nothing without it.
   * @param updates - what the server just said about those rows.
   */
  function applyFlagUpdates(accountId: string, folder: string, updates: readonly MailFlagUpdate[]): void {
    if (updates.length === 0) return
    const byUid = new Map(updates.map(update => [update.uid, update]))
    snapshots.set(accountId, (snapshots.get(accountId) ?? []).map((message) => {
      const update = message.folder === folder ? byUid.get(message.uid) : undefined
      return update === undefined ? message : { ...message, seen: update.seen, flagged: update.flagged }
    }))
    touch()
  }

  /**
   * Drop the rows the server no longer reports.
   *
   * The counterpart of `applyFlagUpdates`: a message deleted on a phone shows up
   * as "asked to refresh, nothing came back". Nothing else in IMAP tells us, so
   * without this the panel keeps a ghost row until the next restart.
   * @param accountId - the account whose rows changed.
   * @param folder - the mailbox those UIDs belong to.
   * @param vanished - the UIDs the server did not answer for.
   */
  function dropVanished(accountId: string, folder: string, vanished: readonly number[]): void {
    if (vanished.length === 0) return
    const gone = new Set(vanished)
    snapshots.set(
      accountId,
      (snapshots.get(accountId) ?? []).filter(message => message.folder !== folder || !gone.has(message.uid)),
    )
    touch()
  }

  /**
   * Remember what the panel is showing, so the next start draws it before any
   * scan can possibly run.
   *
   * Written once per pass rather than once per changed row, and also after a
   * backwards page — otherwise every restart would silently throw away the
   * history the user explicitly asked for.
   * @param accountId - the account whose window to persist.
   */
  async function persistSnapshot(accountId: string): Promise<void> {
    const capturedAt = new Date().toISOString()
    await store.saveMessages(accountId, { at: capturedAt, messages: snapshots.get(accountId) ?? [] })
    cacheAt.set(accountId, capturedAt)
  }

  /**
   * Refresh one folder's counters in the tree the panel draws.
   *
   * These come from the folder's own STATUS during a scan, never from counting
   * the snapshot: the snapshot only holds a window of recent mail, so its unread
   * count would read zero while the mailbox still holds unread messages further
   * back. Before this, the tree kept whatever numbers it was born with — a
   * message read on a phone left "3 未读" sitting there forever.
   * @param accountId - the account that was scanned.
   * @param folder - the folder whose counters moved.
   * @param counters - what the server reported for it.
   */
  function updateMailboxCounters(accountId: string, folder: string, counters: { readonly total: number; readonly unseen: number }): void {
    const current = mailboxes.get(accountId)
    if (current === undefined) return
    mailboxes.set(accountId, current.map(box => (box.path === folder
      ? { ...box, unseen: counters.unseen, total: counters.total }
      : box)))
    touch()
  }

  /**
   * Ask for a fresh pass, at most once per {@link PANEL_REFRESH_MIN_MS} per account.
   *
   * The stamp is taken when the pass is queued rather than when it finishes: the
   * floor exists to stop ten-second polling from stacking passes, and a
   * finishing-time stamp would let a slow scan queue a second one behind it.
   * @param accountId - the account to refresh.
   */
  function requestScan(accountId: string): void {
    const last = lastScanAt.get(accountId) ?? 0
    if (Date.now() - last < PANEL_REFRESH_MIN_MS) return
    lastScanAt.set(accountId, Date.now())
    void scan(accountId)
  }

  /** Open one account's connection, if its code is stored. */
  async function startAccount(account: MailAccount): Promise<void> {
    connections.get(account.id)?.stop()
    connections.delete(account.id)
    setStatus(account.id, 'connecting')
    let password: string | undefined
    try {
      password = await readPassword(credentials(), account.id)
    } catch (error: unknown) {
      setStatus(account.id, 'error', describe(error))
      return
    }
    if (password === undefined) {
      setStatus(account.id, 'error', '未配置授权码（在面板设置里填写）')
      return
    }
    const connection = createConnection(
      factoryFor(account, password),
      account,
      password,
      DEFAULT_CONFIG.imapTimeoutSeconds,
      {
        onNewMail: () => void scan(account.id),
        onStateChange: (status, error) => setStatus(account.id, status, error),
        onAlert: (text) => alerts.set(account.id, text),
        // Push, not poll: the resident connection is selected on INBOX, so the
        // server volunteers these (RFC 3501 §5.2) and the panel's list is right
        // before the next poll can notice.
        onFlagsChange: (updates) => applyFlagUpdates(account.id, WATCHED_FOLDER, updates),
        onExpunge: (uids) => dropVanished(account.id, WATCHED_FOLDER, uids),
        onLog: (message) => ctx.logger.info(`mail: ${message}`),
      },
    )
    connections.set(account.id, connection)
    try {
      await connection.start()
      mailboxes.set(account.id, [...(await connection.listMailboxes())])
      touch()
      // Start the first pass now instead of waiting for an `exists` event (the
      // connection stays idle until a mailbox is selected) or the fallback sweep:
      // the panel may already be open, and it draws whatever the snapshot holds.
      void scan(account.id)
    } catch (error: unknown) {
      setStatus(account.id, 'error', describe(error))
    }
  }

  /**
   * The text a trigger hands to the agent.
   *
   * The scan's own preview is 2 KB of raw source — the headers, on most mail —
   * which is why the live snapshot carries almost no previews at all. A prompt
   * built from that says nothing but the subject, and "here is a subject, work
   * it out" is not something an agent can act on. A message that is really
   * about to be handed over is therefore read first, with the same fetch the
   * reading pane uses.
   * @param connection - the account's session, already connected.
   * @param folder - the folder the message sits in.
   * @param uid - the message.
   * @param fallback - the scan's preview, used when the body cannot be read.
   * @returns the capped body, or the preview when there was nothing better.
   */
  async function readBody(connection: MailConnection, folder: string, uid: number, fallback: string): Promise<string> {
    try {
      const detail = await connection.fetchDetail(folder, uid)
      return detail === undefined ? fallback : promptBody(detail.text, fallback)
    } catch (error: unknown) {
      // A body that cannot be read is no reason to drop the message: hand over
      // what the scan already has rather than losing the trigger entirely.
      ctx.logger.warn(`mail: reading the body of uid ${String(uid)} failed: ${describe(error)}`)
      return fallback
    }
  }

  /**
   * One incremental pass over {@link WATCHED_FOLDER}, serialized per account.
   *
   * The ledger write comes before the trigger on purpose: if the trigger fails,
   * the message stays in the panel and the user can ask for it again, whereas
   * the reverse order would silently drop it.
   * @param accountId - the account to scan.
   * @returns a promise that settles when this pass (and any queued before it) is done.
   */
  function scan(accountId: string): Promise<void> {
    const previous = scanning.get(accountId) ?? Promise.resolve()
    const pass = previous.then(async () => {
      if (stopping) return
      stages.set(accountId, 'starting')
      const account = store.accounts().find(candidate => candidate.id === accountId)
      const connection = connections.get(accountId)
      if (account === undefined || connection === undefined) {
        stages.set(accountId, 'no-account')
        return
      }
      // No stored code means the connection never logged in, so there is nothing
      // to scan over. The connection is the only session now, so this is a
      // precondition rather than a credential for a scan of its own.
      stages.set(accountId, 'credentials')
      if (await readPassword(credentials(), accountId) === undefined) {
        stages.set(accountId, 'no-password')
        return
      }
      stages.set(accountId, 'scanning')

      const folder = WATCHED_FOLDER
      const cursor = store.cursor(accountId, folder)
      // The cursor records how far the *trigger* got, and it outlives the process.
      // The list is drawn from an in-memory snapshot that does not: after a
      // restart the cursor points past the whole mailbox while there is nothing
      // to show, and an incremental pass would find no new mail and leave the
      // panel empty forever.
      //
      // An empty snapshot is not the only one that needs refilling. A server can
      // expose less mail than it holds while it is still indexing: QQ answered
      // with 53 messages when the account was first connected and 808 an hour
      // later, and an incremental pass would never go back for the difference.
      // So refill whenever the snapshot is short of the window it is allowed —
      // bounded by maxListMessages, so it stops once the window is full.
      const held = (snapshots.get(accountId) ?? []).length
      const known = mailboxes.get(accountId)?.find(box => box.path === folder)?.total ?? 0
      const backfill = cursor === undefined
        || held === 0
        || (held < DEFAULT_CONFIG.maxListMessages && known > held)
      const outcome = await connection.scan({
        folder,
        fromUid: cursor === undefined || backfill ? 1 : cursor.lastUid + 1,
        knownUidValidity: cursor?.uidValidity ?? 0,
        maxMessages: DEFAULT_CONFIG.maxListMessages,
        // Re-read what is on screen: an incremental scan never revisits a UID it
        // already handed over, so a message read elsewhere would stay bold here.
        // Only this folder's rows: the pass runs against one selected mailbox, and
        // a UID from another folder would name an unrelated message there.
        refreshUids: (snapshots.get(accountId) ?? [])
          .filter(message => message.folder === folder)
          .map(message => message.uid),
      })
      stages.set(accountId, 'merging')

      // A rebuilt mailbox restarts its UIDs. Everything stored about it — cursor,
      // dedupe ledger, snapshot — describes messages that no longer exist, and a
      // stale UID can end up addressing a different message entirely, so that
      // folder is forgotten rather than adjusted. This pass was aimed at the old
      // generation's UIDs and is dropped whole with it; the next one sees no
      // cursor and backfills from 1. Only *this* folder is dropped: the account's
      // other folders are a different mailbox with their own generation.
      if (cursor !== undefined && cursor.uidValidity !== outcome.uidValidity) {
        await store.forgetFolder(accountId, folder)
        dropFolderRows(accountId, folder)
        uidValidityOf.set(accountId, outcome.uidValidity)
        return
      }
      uidValidityOf.set(accountId, outcome.uidValidity)
      mergeSnapshot(accountId, outcome.messages.map(message => message.summary))
      applyFlagUpdates(accountId, folder, outcome.refreshed)
      dropVanished(accountId, folder, outcome.vanished)
      updateMailboxCounters(accountId, folder, outcome.counters)
      if (outcome.searchUnreliable) {
        ctx.logger.warn(`mail: ${accountId} answered SEARCH with nothing; fell back to a client-side filter`)
      }

      if (!backfill) {
        // Whichever engine owns triage: with `mailflow` mounted the message is
        // emitted and this plugin is done with it; without it the account's own
        // trigger config runs, exactly as it did before mailflow existed.
        // Probed per pass, not once, because a Loader row may be applied later.
        const fire = ctx.get('mailflow') === undefined ? createTriggerer(triggerHost()) : undefined
        for (const message of outcome.messages) {
          await handOver(message, {
            accountId,
            accountName: account.name,
            trigger: account.trigger,
            uidValidity: outcome.uidValidity,
            ...(fire === undefined ? {} : { fire }),
            ledger: store,
            readBody: (uid, fallback) => readBody(connection, folder, uid, fallback),
            emit: (payload) => ctx.emit('mail/received', payload),
            log: (line) => ctx.logger.warn(line),
          })
        }
      }

      await store.setCursor(accountId, folder, {
        folder,
        uidValidity: outcome.uidValidity,
        lastUid: outcome.maxUid,
      } satisfies ScanCursor)

      // Remember what the panel is showing — once per pass, not once per changed
      // row. The next start draws this before any scan can possibly run.
      await persistSnapshot(accountId)
      // A pass that got this far has nothing to complain about any more.
      syncErrors.delete(accountId)
      stages.set(accountId, 'done')
    }).catch((error: unknown) => {
      const text = describe(error)
      ctx.logger.warn(`mail: scanning ${accountId} failed: ${text}`)
      // Surface it: a scan that keeps failing leaves the list empty, and "no mail"
      // and "sync is broken" look identical to the person reading the panel.
      syncErrors.set(accountId, `同步失败：${text}`)
    })
    scanning.set(accountId, pass)
    return pass
  }

  /**
   * Fetch one page of older mail for one folder.
   *
   * The panel draws a window, and this is the only way it ever grows *backwards*:
   * a scan walks forwards from a cursor, so it can never reach mail older than
   * the newest page the snapshot already holds. A page starts below the oldest
   * row held for that folder — and "below nothing" is simply the newest page,
   * which is why opening a folder the plugin has never scanned is the same call.
   *
   * Deliberately touches neither the trigger ledger nor the cursor: those record
   * what has been handed to an agent, and re-reading history must not re-fire it.
   * @param accountId - the account to page through.
   * @param folder - the mailbox to page through.
   * @param page - how many rows one page holds.
   * @returns the route result, carrying how many rows the page actually added.
   */
  async function loadMore(
    accountId: string,
    folder: string,
    page = DEFAULT_CONFIG.maxListMessages,
  ): Promise<RouteResult> {
    const connection = connections.get(accountId)
    if (connection === undefined) {
      return { ok: false, code: 'account_offline', message: '这个账号当前没有连接' }
    }
    const held = (snapshots.get(accountId) ?? []).filter(message => message.folder === folder)
    const knownUidValidity = held[0]?.uidValidity ?? 0
    const oldest = held.length === 0 ? undefined : Math.min(...held.map(message => message.uid))
    const outcome = await connection.scan({
      folder,
      fromUid: 1,
      ...(oldest === undefined ? {} : { beforeUid: oldest }),
      knownUidValidity,
      maxMessages: page,
    })
    // A rebuilt mailbox means every UID held for this folder now names a
    // different message, so the folder starts over from its newest page.
    if (held.length > 0 && knownUidValidity !== outcome.uidValidity) {
      await store.forgetFolder(accountId, folder)
      dropFolderRows(accountId, folder)
      const fresh = await connection.scan({
        folder,
        fromUid: 1,
        knownUidValidity: outcome.uidValidity,
        maxMessages: page,
      })
      const restarted = fresh.messages.map(message => message.summary)
      const added = mergeSnapshot(accountId, restarted)
      await persistSnapshot(accountId)
      return { ok: true, added, exhausted: restarted.length < page }
    }
    const rows = outcome.messages.map(message => message.summary)
    const added = mergeSnapshot(accountId, rows)
    updateMailboxCounters(accountId, folder, outcome.counters)
    await persistSnapshot(accountId)
    // A page shorter than the one asked for means the server had nothing older,
    // which is the panel's cue to stop offering "load more" for this folder.
    return { ok: true, added, exhausted: rows.length < page }
  }

  /**
   * The preset lists the drawer offers, cached because `/state` is synchronous.
   *
   * Read once at boot and re-read whenever a pass finds them empty: a session
   * created before the host finished mounting its registries would otherwise lock
   * the two dropdowns shut until the plugin restarts.
   */
  const presetCache: { agents: PresetChoice[]; permissions: PresetChoice[] } = { agents: [], permissions: [] }
  let refreshingPresets = false

  /** Re-read both preset lists from the host; never throws. */
  async function refreshPresets(): Promise<void> {
    if (refreshingPresets) return
    refreshingPresets = true
    try {
      const read = await presetChoices(triggerHost())
      presetCache.agents = read.agents
      presetCache.permissions = read.permissions
      touch()
    } catch (error: unknown) {
      ctx.logger.warn(`mail: reading the preset lists failed: ${describe(error)}`)
    } finally {
      refreshingPresets = false
    }
  }

  /** Start every configured account and the fallback sweep that covers missed events. */
  async function boot(): Promise<void> {
    try {
      await store.load()
    } catch (error: unknown) {
      ctx.logger.warn(`mail: reading the state file failed: ${describe(error)}`)
    }
    if (stopping) return
    // Before any account connects: the drawer's two preset fields are dropdowns
    // now, and an empty list would leave them unusable until the first pass.
    void refreshPresets()
    for (const account of store.accounts()) {
      // Draw what was on screen last time before touching the network: after a
      // restart the cursor already points past the mailbox, so without this the
      // panel would sit empty until the first incremental scan found something.
      try {
        const cached = store.cachedMessages(account.id)
        if (cached !== undefined) {
          mergeSnapshot(account.id, cached.messages)
          cacheAt.set(account.id, cached.at)
        }
      } catch (error: unknown) {
        // A list that cannot be restored must not stop the account from
        // connecting — but it has to leave a trace, or an empty panel looks
        // exactly like a mailbox with no mail in it.
        ctx.logger.warn(`mail: restoring the cached list for ${account.id} failed: ${describe(error)}`)
        syncErrors.set(account.id, `恢复缓存列表失败：${describe(error)}`)
      }
      void startAccount(account)
    }
    fallback = setInterval(() => {
      for (const account of store.accounts()) void scan(account.id)
    }, DEFAULT_CONFIG.fallbackScanSeconds * 1000)
    // Never hold the host process open on account of a mail sweep.
    fallback.unref()
  }

  /** Keep the snapshot honest after the panel changes a flag or moves a message. */
  function applyActionLocally(action: MailAction): void {
    const current = snapshots.get(action.accountId) ?? []
    const touched = new Set(action.uids)
    if (action.op === 'delete' || action.op === 'move') {
      snapshots.set(action.accountId, current.filter(message => !touched.has(message.uid)))
      // Without this the panel's next poll would be told "nothing changed" and the
      // row the user just acted on would stay on screen.
      touch()
      return
    }
    snapshots.set(action.accountId, current.map((message) => {
      if (!touched.has(message.uid)) return message
      switch (action.op) {
        case 'markRead': return { ...message, seen: true }
        case 'markUnread': return { ...message, seen: false }
        case 'flag': return { ...message, flagged: true }
        case 'unflag': return { ...message, flagged: false }
        default: return message
      }
    }))
    touch()
  }

  /**
   * The mail capabilities other plugins use.
   *
   * Registered as a service rather than read out of a module global so a
   * consumer follows the plugin's own lifetime: it appears when this row is
   * applied and disappears when it is unloaded, and `ctx.get('mail')` answering
   * undefined is the documented normal state of a deployment without it.
   */
  const service: MailService = {
    accounts: (): readonly MailAccount[] => store.accounts(),

    listMailboxes: async (accountId: string): Promise<readonly MailboxView[]> => {
      const connection = connections.get(accountId)
      if (connection === undefined) return mailboxes.get(accountId) ?? []
      try {
        // Read from the session rather than answering the cache: a caller
        // looking for a folder the user created on another client wants the
        // server's answer, and the cache is refreshed with it either way.
        const listed = [...await connection.listMailboxes()]
        mailboxes.set(accountId, listed)
        touch()
        return listed
      } catch (error: unknown) {
        ctx.logger.warn(`mail: listing the folders of ${accountId} failed: ${describe(error)}`)
        return mailboxes.get(accountId) ?? []
      }
    },

    ensureFolder: async (accountId: string, path: string) => {
      const connection = connections.get(accountId)
      if (connection === undefined) {
        return { ok: false, code: 'account_offline', message: '这个账号当前没有连接' }
      }
      const created = await connection.mailboxCreate(path)
      // The panel's folder tree is a cache, and a folder created here is not in
      // it: without this refresh, "move to 推广" looks like it did nothing until
      // the next reconnect. Never awaited — the caller has a move to finish.
      if (created.ok) void service.listMailboxes(accountId)
      return created
    },

    applyAction: async (action: MailAction): Promise<RouteResult> => {
      const connection = connections.get(action.accountId)
      if (connection === undefined) {
        return { ok: false, code: 'account_offline', message: '这个账号当前没有连接' }
      }
      const result = await connection.applyAction(action)
      if (result.ok) applyActionLocally(action)
      return result
    },

    fetchDetail: async (accountId: string, folder: string, uid: number): Promise<MailDetail | undefined> => {
      const connection = connections.get(accountId)
      if (connection === undefined) return undefined
      try {
        return await connection.fetchDetail(folder, uid)
      } catch (error: unknown) {
        // "No such message" is the shape the signature promises, so a session
        // that died under it is reported as absent and logged rather than thrown
        // at a caller that has no way to act on the difference.
        ctx.logger.warn(`mail: reading uid ${String(uid)} of ${accountId} failed: ${describe(error)}`)
        return undefined
      }
    },
  }

  // `provide` rather than a bare `set`: it is what makes the name a service a
  // consumer can `inject`, and it is disposed with this plugin's own fiber, so
  // there is nothing to clear by hand on unload.
  ctx.provide('mail', service)

  /** Replace one account's trigger and persist the whole list. */
  async function setTrigger(accountId: string, trigger: unknown): Promise<RouteResult> {
    const accounts = store.accounts()
    const account = accounts.find(candidate => candidate.id === accountId)
    if (account === undefined) return { ok: false, code: 'account_not_found', message: `没有这个账号：${accountId}` }
    const updated: MailAccount = { ...account, trigger: normalizeTrigger(trigger) }
    await store.setAccounts(accounts.map(candidate => (candidate.id === accountId ? updated : candidate)))
    return { ok: true }
  }

  /** Add or replace one account, then (re)connect it. */
  async function saveAccount(input: unknown): Promise<RouteResult> {
    const record = isRecord(input) ? input : {}
    const parsed = normalizeAccountInput(record['account'])
    if (!parsed.ok) return { ok: false, code: 'invalid_account', message: `${parsed.field}: ${parsed.message}` }
    const existing = store.accounts().find(candidate => candidate.id === parsed.value.id)
    const id = parsed.value.id ?? accountIdFor(parsed.value.address, parsed.value.provider)
    const account: MailAccount = {
      ...parsed.value,
      id,
      trigger: normalizeTrigger(isRecord(record['account']) ? record['account']['trigger'] : undefined),
    }
    const password = record['password']
    if (typeof password === 'string' && password.length > 0) {
      try {
        await writePassword(credentials(), id, password)
      } catch (error: unknown) {
        return credentialsFailure(error)
      }
    }
    const accounts = existing === undefined
      ? [...store.accounts(), account]
      : store.accounts().map(candidate => (candidate.id === id ? account : candidate))
    await store.setAccounts(accounts)
    void startAccount(account)
    return { ok: true }
  }

  /** Forget one account: its code, its connection and every record of it. */
  async function dropAccount(accountId: string): Promise<RouteResult> {
    connections.get(accountId)?.stop()
    connections.delete(accountId)
    snapshots.delete(accountId)
    mailboxes.delete(accountId)
    statuses.delete(accountId)
    alerts.delete(accountId)
    uidValidityOf.delete(accountId)
    try {
      await removePassword(credentials(), accountId)
    } catch (error: unknown) {
      const failure = credentialsFailure(error)
      // The account is unusable either way; report the code but finish the removal.
      ctx.logger.warn(`mail: clearing the stored code for ${accountId} failed: ${failure.message}`)
    }
    await store.forget(accountId)
    return { ok: true }
  }

  const routeHost: RouteHost = {
    state: (): MailState => {
      const accounts = store.accounts()
      // The panel polls this every ten seconds. While somebody is looking, ask
      // for a fresh pass — never awaited, because the answer is the snapshot
      // below — so a message read elsewhere stops being bold within about half a
      // minute instead of waiting for the fallback sweep.
      for (const account of accounts) requestScan(account.id)
      // A drawer opened before the host answered gets its dropdowns on the next
      // poll; the read is cheap and never blocks this answer.
      if (presetCache.agents.length === 0) void refreshPresets()
      return {
        version: 1,
        revision,
        collectedAt: new Date().toISOString(),
        // The oldest account's capture time: the panel says "from HH:MM" only
        // when the whole list is that old.
        ...(() => {
          const times = accounts.flatMap((account) => {
            const at = cacheAt.get(account.id)
            return at === undefined ? [] : [at]
          })
          return times.length === 0 ? {} : { cacheAt: [...times].sort()[0] as string }
        })(),
        accounts: accounts.map((account) => {
          const status = statuses.get(account.id)
          const alert = alerts.get(account.id)
          const error = syncErrors.get(account.id) ?? status?.error
          const stage = stages.get(account.id)
          return {
            id: account.id,
            name: account.name,
            address: account.address,
            status: status?.status ?? 'idle',
            ...(error === undefined ? {} : { lastError: error }),
            // Presented by the panel, never logged away: the server sent it for
            // the person reading the mail (RFC 2683 §3.4.11).
            ...(alert === undefined ? {} : { alert }),
            ...(stage === undefined ? {} : { stage }),
            unread: (snapshots.get(account.id) ?? []).filter(message => !message.seen).length,
          }
        }),
        mailboxes: [...mailboxes.values()].flat(),
        // No trim here: every account's window is already bounded by
        // MAX_SNAPSHOT_MESSAGES in `mergeSnapshot`, and trimming again at a
        // different number would silently undo "load more" for the account whose
        // rows happened to sort last.
        messages: [...snapshots.entries()]
          .flatMap(([, messages]) => messages)
          .sort((left, right) => Date.parse(right.date) - Date.parse(left.date)),
        config: {
          fallbackScanSeconds: DEFAULT_CONFIG.fallbackScanSeconds,
          maxListMessages: DEFAULT_CONFIG.maxListMessages,
          maxWindowMessages: MAX_SNAPSHOT_MESSAGES,
          accounts,
          triggerAvailability: triggerAvailability(triggerHost()),
          workbenchAvailable: workbenchAvailable(triggerHost()),
          presets: presetCache,
          preferences: store.preferences(),
        },
      }
    },

    detail: async (accountId: string, folder: string, uid: number): Promise<MailDetail | undefined> =>
      connections.get(accountId)?.fetchDetail(folder, uid),

    attachment: async (accountId: string, folder: string, uid: number, part: string): Promise<AttachmentPayload | undefined> => {
      const found = await connections.get(accountId)?.downloadAttachment(folder, uid, part)
      return found === undefined
        ? undefined
        : { filename: found.filename, contentType: found.contentType, content: found.content }
    },

    panelDocument: (): string => readFileSync(panelDocumentPath(), 'utf8'),

    action: async (input: unknown): Promise<RouteResult> => {
      const parsed = normalizeAction(input)
      if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message }
      // The same call the service hands out, so the panel and another plugin
      // cannot drift into two versions of "read a message".
      return await service.applyAction(parsed.value)
    },

    config: async (input: unknown): Promise<RouteResult> => {
      const record = isRecord(input) ? input : {}
      switch (record['op']) {
        case 'addAccount':
        case 'updateAccount':
          return await saveAccount(input)
        case 'removeAccount': {
          const accountId = record['accountId']
          if (typeof accountId !== 'string' || accountId === '') {
            return { ok: false, code: 'invalid_account', message: 'accountId 不能为空' }
          }
          return await dropAccount(accountId)
        }
        case 'testAccount': {
          const draftInput = record['draft']
          let draft: DraftAccount
          if (draftInput !== undefined) {
            const parsed = normalizeDraft(draftInput)
            if (!parsed.ok) return { ok: false, code: 'invalid_account', message: `${parsed.field}: ${parsed.message}` }
            draft = parsed.value
          } else {
            // The drawer offers this when the user edits a saved account without
            // retyping the code: probe with what is already stored.
            const accountId = record['accountId']
            const account = typeof accountId === 'string'
              ? store.accounts().find(candidate => candidate.id === accountId)
              : undefined
            if (account === undefined) {
              return { ok: false, code: 'account_not_found', message: `没有这个账号：${String(accountId)}` }
            }
            const password = await readPassword(credentials(), account.id)
            if (password === undefined) {
              return { ok: false, code: 'credentials_unavailable', message: '这个账号还没有保存授权码' }
            }
            draft = {
              address: account.address,
              imapHost: account.imapHost,
              imapPort: account.imapPort,
              secure: account.secure,
              password,
            }
          }
          return await testAccount(probe, draft, DEFAULT_CONFIG.imapTimeoutSeconds)
        }
        case 'setTrigger': {
          const accountId = record['accountId']
          if (typeof accountId !== 'string' || accountId === '') {
            return { ok: false, code: 'invalid_account', message: 'accountId 不能为空' }
          }
          return await setTrigger(accountId, record['trigger'])
        }
        case 'setPreferences': {
          const parsed = normalizePreferences(record['preferences'])
          if (!parsed.ok) return { ok: false, code: 'invalid_config', message: `${parsed.field}: ${parsed.message}` }
          await store.setPreferences({ ...store.preferences(), ...parsed.value })
          // The panel polls with the revision it already holds, so a change the
          // user just made has to move it — otherwise the drawer keeps showing
          // the old switch and the reading pane keeps the old behaviour.
          touch()
          return { ok: true }
        }
        case 'trustSender': {
          const address = senderKey(record['address'])
          const trusted = record['trusted']
          if (address === undefined) return { ok: false, code: 'invalid_config', message: '不是有效的发件人地址' }
          if (typeof trusted !== 'boolean') return { ok: false, code: 'invalid_config', message: 'trusted 必须是布尔值' }
          const preferences = store.preferences()
          await store.setPreferences({
            ...preferences,
            trustedSenders: withTrustedSender(preferences.trustedSenders, address, trusted),
          })
          touch()
          return { ok: true }
        }
        default:
          return { ok: false, code: 'invalid_config', message: `未知操作：${String(record['op'])}` }
      }
    },

    refresh: async (input: unknown): Promise<RouteResult> => {
      const record = isRecord(input) ? input : {}
      const accountId = typeof record['accountId'] === 'string' && record['accountId'] !== ''
        ? record['accountId']
        : undefined
      const targets = accountId === undefined
        ? store.accounts()
        : store.accounts().filter(candidate => candidate.id === accountId)
      if (targets.length === 0) {
        return { ok: false, code: 'account_not_found', message: `没有这个账号：${String(accountId)}` }
      }
      // Bypasses the panel-poll floor on purpose: the user asked for this, and a
      // button that appears to do nothing is worse than one extra round trip. The
      // pass runs in the background; the panel watches `stage` until it is done.
      for (const account of targets) {
        lastScanAt.set(account.id, 0)
        void scan(account.id)
        // The folder tree is a cache filled when the connection came up, so a
        // folder renamed on the server keeps its old name here and then fails to
        // open. This is the one moment the user asks for the server's view as it
        // is now, so the tree is re-listed alongside the scan.
        void service.listMailboxes(account.id)
      }
      return { ok: true }
    },

    more: async (input: unknown): Promise<RouteResult> => {
      const record = isRecord(input) ? input : {}
      const accountId = typeof record['accountId'] === 'string' && record['accountId'] !== ''
        ? record['accountId']
        : undefined
      // No folder means the panel's combined view, which is the watched folder:
      // it is the only mailbox a scan keeps current, so it is the one "older
      // mail" can mean without the caller naming a folder.
      const folder = typeof record['folder'] === 'string' && record['folder'] !== ''
        ? record['folder']
        : WATCHED_FOLDER
      const targets = accountId === undefined
        ? store.accounts()
        : store.accounts().filter(candidate => candidate.id === accountId)
      if (targets.length === 0) {
        return { ok: false, code: 'account_not_found', message: `没有这个账号：${String(accountId)}` }
      }
      let added = 0
      let exhausted = true
      let failure: RouteResult | undefined
      try {
        for (const account of targets) {
          // One page at a time on purpose: the connection holds a single mailbox
          // lock, so these would serialise anyway, and each page touches the
          // snapshot before the next one starts — the panel sees the list grow
          // instead of waiting for the slowest account.
          const result = await loadMore(account.id, folder)
          if (!result.ok) {
            failure = result
            continue
          }
          added += result.added ?? 0
          exhausted = exhausted && result.exhausted === true
        }
      } catch (error: unknown) {
        return { ok: false, code: 'folder_unavailable', message: `打不开文件夹「${folder}」：${describe(error)}` }
      }
      // A partial answer beats a failed one: with two accounts, one offline must
      // not hide the page the other one just brought.
      if (failure !== undefined && added === 0) return failure
      return { ok: true, added, exhausted }
    },
  }

  registerRoutes(ctx, routeHost)

  // Waits for the credentials service rather than running straight away: this
  // row can be applied before the provider that owns the code store is mounted,
  // and reading a code during that window reports "not configured" about a code
  // that is sitting on disk. `inject` is the framework's own answer to that
  // ordering, and it is how the routes above wait for `webServer`.
  ctx.inject(['credentials'], (scoped) => {
    scoped.effect(() => {
      void boot()
      return () => {
        stopping = true
        if (fallback !== undefined) clearInterval(fallback)
        for (const connection of connections.values()) void connection.stop()
        connections.clear()
      }
    }, 'mail: connections')
  })
}

/**
 * What one hand-over needs from the scan pass.
 *
 * Passed explicitly rather than captured in a closure so the two paths — the
 * triage engine and the account's own trigger — can be driven side by side in a
 * test. That is the only way to hold the "a deployment without mailflow behaves
 * exactly as it did before" promise down.
 */
export interface HandoverDeps {
  readonly accountId: string
  readonly accountName: string
  /** The account's own trigger; read only on the fallback path. */
  readonly trigger: TriggerConfig
  readonly uidValidity: number
  /**
   * The fallback triggerer, or undefined when a triage engine owns the message.
   *
   * Undefined is not "nothing happens": the message is emitted as
   * `mail/received` instead, and whoever listens decides what to do with it.
   */
  readonly fire?: Triggerer | undefined
  /** Where "this message was already handed over" is recorded. */
  readonly ledger: Pick<MailStore, 'isTriggered' | 'markTriggered'>
  readonly readBody: (uid: number, fallback: string) => Promise<string>
  readonly emit: (payload: MailReceivedPayload) => void
  readonly log: (message: string) => void
}

/**
 * Hand one scanned message over, once.
 *
 * The ledger is written **before** anything is handed over: if the hand-over
 * fails, the message stays in the panel for the user to act on, whereas the
 * reverse order would silently drop it. That is why a mailflow listener that
 * throws never sees a message twice.
 *
 * The body is read lazily and at most once, whoever ends up needing it: the
 * list preview is 2 KB of headers for most mail, and a message that is decided
 * on its headers must not cost an IMAP round trip.
 * @param message - the row the scan just found.
 * @param deps - the ledger, the reader and whichever engine owns the message.
 */
export async function handOver(message: NormalizedMessage, deps: HandoverDeps): Promise<void> {
  const summary = message.summary
  const key = messageKey(summary.folder, deps.uidValidity, summary.uid)
  if (deps.ledger.isTriggered(deps.accountId, key)) return
  await deps.ledger.markTriggered(deps.accountId, key)

  let body: string | undefined
  const read = async (): Promise<string> => {
    body ??= await deps.readBody(summary.uid, message.preview)
    return body
  }

  if (deps.fire === undefined) {
    deps.emit({
      accountId: deps.accountId,
      accountName: deps.accountName,
      summary,
      readBody: read,
    })
    return
  }

  const resolved = await resolveTrigger(deps.trigger, summary, read)
  // No rule claimed it, or the one that did asks for no more than a row in the
  // list — either way nothing is handed to an agent. The workbench notice is not
  // pushed here: `resolveTrigger` carries the switch onto `resolved`, and `fire`
  // pushes it once. Pushing in both places is how every matched message used to
  // arrive twice.
  if (resolved.mode === 'panel' && resolved.notifyWorkbench !== true) return
  const result = await deps.fire.fire(deps.accountId, resolved, summary, await read(), deps.accountName)
  if (!result.ok) {
    deps.log(`mail: handing ${summary.subject || '(no subject)'} to the agent failed: ${result.message}`)
  }
}

/** Whether a parsed body is a JSON object rather than an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Turn a credentials-service failure into the code the routes answer with. */
function credentialsFailure(error: unknown): { ok: false; code: string; message: string } {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'credentials_error'
  return { ok: false, code, message: describe(error) }
}

/** Describe any thrown value for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
