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
import { DEFAULT_CONFIG, normalizeAccountInput, normalizeAction, normalizeDraft, normalizeTrigger } from './config.ts'
import {
  createConnection, imapFactoryFor, probeAccount, WATCHED_FOLDER,
  type ImapFactory, type MailConnection, type MailFlagUpdate,
} from './imap.ts'
import { promptBody } from './rules.ts'
import { createStore, messageKey, type MailStore } from './store.ts'
import { createTriggerer, presetChoices, resolveTrigger, triggerAvailability, type TriggerHost } from './trigger.ts'
import { registerRoutes, type AttachmentPayload, type RouteHost } from './routes.ts'
import type {
  AccountStatus, DraftAccount, MailAccount, MailAction, MailDetail, MailState, MailSummary,
  MailboxView, PresetChoice, RouteResult, ScanCursor,
} from './types.ts'

export * from './paths.ts'
export * from './types.ts'

/**
 * The only folder the scan loop watches; other folders are listed but not scanned.
 *
 * Declared in `imap.ts`, which is where the connection SELECTs it: a mailbox
 * only announces changes while it is the selected one, so the constant and the
 * SELECT have to agree.
 */
export { WATCHED_FOLDER }

/** Largest number of messages the snapshot keeps per account. */
const SNAPSHOT_LIMIT = DEFAULT_CONFIG.maxListMessages

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

  /** Fold freshly scanned messages into the snapshot, newest first. */
  function mergeSnapshot(accountId: string, incoming: readonly MailSummary[]): void {
    const byUid = new Map<number, MailSummary>()
    for (const message of snapshots.get(accountId) ?? []) byUid.set(message.uid, message)
    for (const message of incoming) byUid.set(message.uid, message)
    snapshots.set(
      accountId,
      [...byUid.values()].sort((left, right) => right.uid - left.uid).slice(0, SNAPSHOT_LIMIT),
    )
    touch()
  }

  /**
   * Fold re-read flags into the snapshot.
   *
   * Only `seen` and `flagged` move: the rest of a row was already fetched, and
   * rebuilding it here would risk replacing a newer summary with an older one.
   * @param accountId - the account whose rows changed.
   * @param updates - what the server just said about those rows.
   */
  function applyFlagUpdates(accountId: string, updates: readonly MailFlagUpdate[]): void {
    if (updates.length === 0) return
    const byUid = new Map(updates.map(update => [update.uid, update]))
    snapshots.set(accountId, (snapshots.get(accountId) ?? []).map((message) => {
      const update = byUid.get(message.uid)
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
   * @param vanished - the UIDs the server did not answer for.
   */
  function dropVanished(accountId: string, vanished: readonly number[]): void {
    if (vanished.length === 0) return
    const gone = new Set(vanished)
    snapshots.set(accountId, (snapshots.get(accountId) ?? []).filter(message => !gone.has(message.uid)))
    touch()
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
        onFlagsChange: (updates) => applyFlagUpdates(account.id, updates),
        onExpunge: (uids) => dropVanished(account.id, uids),
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
        refreshUids: (snapshots.get(accountId) ?? []).map(message => message.uid),
      })
      stages.set(accountId, 'merging')

      // A rebuilt mailbox restarts its UIDs. Everything stored about it — cursor,
      // dedupe ledger, snapshot — describes messages that no longer exist, and a
      // stale UID can end up addressing a different message entirely, so the whole
      // folder is forgotten rather than adjusted. This pass was aimed at the old
      // generation's UIDs and is dropped whole with it; the next one sees no
      // cursor and backfills from 1.
      if (cursor !== undefined && cursor.uidValidity !== outcome.uidValidity) {
        await store.forgetFolder(accountId, folder)
        snapshots.delete(accountId)
        uidValidityOf.set(accountId, outcome.uidValidity)
        return
      }
      uidValidityOf.set(accountId, outcome.uidValidity)
      mergeSnapshot(accountId, outcome.messages.map(message => message.summary))
      applyFlagUpdates(accountId, outcome.refreshed)
      dropVanished(accountId, outcome.vanished)
      updateMailboxCounters(accountId, folder, outcome.counters)
      if (outcome.searchUnreliable) {
        ctx.logger.warn(`mail: ${accountId} answered SEARCH with nothing; fell back to a client-side filter`)
      }

      if (!backfill) {
        const fire = createTriggerer(triggerHost())
        for (const message of outcome.messages) {
          const key = messageKey(folder, outcome.uidValidity, message.summary.uid)
          if (store.isTriggered(accountId, key)) continue
          await store.markTriggered(accountId, key)
          // One read per message, whoever ends up needing it: a rule that tests a
          // keyword reads it while deciding, and the trigger reads it again to
          // compose the prompt.
          let body: string | undefined
          const read = async (): Promise<string> => {
            body ??= await readBody(connection, folder, message.summary.uid, message.preview)
            return body
          }
          const resolved = await resolveTrigger(account.trigger, message.summary, read)
          // No rule claimed it, or the one that did asks for no more than a row
          // in the list — either way nothing is handed over and no body is read.
          if (resolved.mode === 'panel') continue
          const result = await fire.fire(accountId, resolved, message.summary, await read())
          if (!result.ok) {
            ctx.logger.warn(`mail: handing ${message.summary.subject || '(no subject)'} to the agent failed: ${result.message}`)
          }
        }
      }

      await store.setCursor(accountId, folder, {
        folder,
        uidValidity: outcome.uidValidity,
        lastUid: outcome.maxUid,
      } satisfies ScanCursor)

      // Remember what the panel is showing — once per pass, not once per changed
      // row. The next start draws this before any scan can possibly run.
      const capturedAt = new Date().toISOString()
      await store.saveMessages(accountId, { at: capturedAt, messages: snapshots.get(accountId) ?? [] })
      cacheAt.set(accountId, capturedAt)
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
        messages: [...snapshots.entries()]
          .flatMap(([, messages]) => messages)
          .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
          .slice(0, SNAPSHOT_LIMIT),
        config: {
          fallbackScanSeconds: DEFAULT_CONFIG.fallbackScanSeconds,
          maxListMessages: DEFAULT_CONFIG.maxListMessages,
          accounts,
          triggerAvailability: triggerAvailability(triggerHost()),
          presets: presetCache,
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
      const connection = connections.get(parsed.value.accountId)
      if (connection === undefined) {
        return { ok: false, code: 'account_offline', message: '这个账号当前没有连接' }
      }
      const result = await connection.applyAction(parsed.value)
      if (result.ok) applyActionLocally(parsed.value)
      return result
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
      }
      return { ok: true }
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
