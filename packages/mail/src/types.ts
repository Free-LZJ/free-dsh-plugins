/**
 * The shapes every half of the mail plugin agrees on.
 *
 * Types live in one module because four independently written pieces have to
 * fit together: the account store, the IMAP scanner, the triage engine, and the
 * HTTP surface the panel reads. Nothing here knows about imapflow, cordis or the
 * DOM.
 *
 * @module @free-lzj/dsh-mail/types
 */

import type { Config as TriageConfig } from './triage/types.ts'

/* ─────────────────────────────── accounts ─────────────────────────────── */

/** Mailbox provider: only affects the defaults the settings drawer offers. */
export type MailProvider = 'qq' | 'gmail' | 'custom'

/**
 * One configured mailbox.
 *
 * The password/authorization code is **not** here: it lives in the credentials
 * service under `dsh-mail/<id>`, so this record is safe to serialize anywhere.
 * `id` must match `/^[a-z][a-z0-9-]*$/` because it is also a credentials key
 * segment — generate it as a lowercase hex hash, never from the raw address.
 *
 * New mail is handled by the triage rules (`$DSH_HOME/mail/triage/rules.yml`),
 * which are the same for every account; there is deliberately nothing
 * per-account to configure here any more.
 */
export interface MailAccount {
  readonly id: string
  readonly name: string
  readonly address: string
  readonly provider: MailProvider
  readonly imapHost: string
  readonly imapPort: number
  readonly secure: boolean
}

/* ─────────────────────────────── messages ─────────────────────────────── */

/**
 * The headers a triage rule may read, keyed by lowercased name.
 *
 * Only the names in `TRIAGE_HEADERS` (`src/headers.ts`) appear here, and a
 * header that is absent — or present but empty — is absent from the object
 * rather than mapped to an empty string, so "does this message carry a
 * List-Unsubscribe" is answerable by looking at the keys.
 */
export interface MailHeaders {
  readonly [name: string]: string | undefined
}

/** One message as the panel list shows it. */
export interface MailSummary {
  readonly accountId: string
  readonly folder: string
  readonly uid: number
  /** With `uid` this is the stable identity of a message across reconnects. */
  readonly uidValidity: number
  readonly subject: string
  readonly from: MailAddress
  readonly date: string
  readonly seen: boolean
  readonly flagged: boolean
  readonly hasAttachments: boolean
  /** Plain-text preview, already truncated. */
  readonly snippet: string
  /** The triage headers of the message; see {@link MailHeaders}. */
  readonly headers: MailHeaders
}

/** One address as the envelope reports it. */
export interface MailAddress {
  readonly name?: string
  readonly address: string
}

/** One attachment as the message body reports it. */
export interface MailAttachment {
  /** IMAP body part identifier, e.g. `2` or `2.1`. */
  readonly part: string
  readonly filename: string
  readonly contentType: string
  readonly size: number
}

/** One message with its body, for the reading pane. */
export interface MailDetail extends MailSummary {
  readonly to: readonly MailAddress[]
  readonly cc: readonly MailAddress[]
  /** Plain text of the message. Nothing cuts it but the per-body-part cap in `imap.ts`. */
  readonly text: string
  /**
   * Raw HTML from the sender, except that `cid:` images are already inlined as
   * `data:` URIs — a browser cannot resolve a content id, and the panel would
   * otherwise have to block every embedded picture. The panel renders it in a
   * sandboxed iframe.
   */
  readonly html?: string
  /**
   * The parts the message is made of, read from its structure.
   *
   * Nothing here was downloaded: an attachment is listed by name, type and size
   * from the structure the server already described, and its bytes are fetched
   * only when somebody clicks it.
   */
  readonly attachments: readonly MailAttachment[]
  /** True when one body part was itself past the per-part cap, so it was cut. */
  readonly truncated: boolean
}

/* ──────────────────────────── IMAP (host only) ─────────────────────────── */

/** What one scan pass needs to know about a folder. */
export interface ScanCursor {
  readonly folder: string
  /** Server-side mailbox generation; a change invalidates `lastUid`. */
  readonly uidValidity: number
  /** Highest UID already processed. */
  readonly lastUid: number
}

/** The result of normalizing one fetched message. */
export interface NormalizedMessage {
  readonly summary: MailSummary
  /** Body preview for the trigger prompt and the list; same text as `summary.snippet`. */
  readonly preview: string
}

/* ──────────────────────────── reading preferences ─────────────────────── */

/**
 * How the reading pane shows a message, as opposed to which mailbox it came from.
 *
 * One record for the whole plugin rather than one per account: whether remote
 * images may load is a judgement about the *sender*, and the same sender writes
 * to every mailbox a person has.
 */
export interface MailPreferences {
  /**
   * Whether a message's remote images load on their own.
   *
   * Default true — the mail is yours and the pictures are part of it. Turned off,
   * every remote image is replaced before the frame sees it (a tracking pixel is
   * a read receipt), and the pane offers a per-message load plus a sender
   * whitelist. Images that arrive *with* the message (an inline part, a `data:`
   * URI) load either way: they cost no request.
   */
  readonly loadRemoteImages: boolean
  /**
   * Senders whose remote images load even when {@link loadRemoteImages} is off.
   *
   * Lowercased bare addresses, matched against the envelope's `From`. A whole
   * domain is deliberately not allowed: "qq.com" is not a sender.
   */
  readonly trustedSenders: readonly string[]
}

/* ───────────────────────────── persisted state ────────────────────────── */

/** One account's scan bookkeeping. */
export interface AccountState {
  /** Per-folder cursor, keyed by folder path. */
  readonly cursors: Readonly<Record<string, ScanCursor>>
  /** Dedupe ledger, newest last; keys are `folder:uidValidity:uid`. */
  readonly triggered: readonly { readonly key: string; readonly at: string }[]
}

/** The whole `state.json`. */
export interface MailStateFile {
  readonly version: 1
  readonly accounts: Readonly<Record<string, AccountState>>
}

/* ─────────────────────────────── HTTP views ───────────────────────────── */

/** Connection state of one account as the panel shows it. */
export type AccountStatus = 'connected' | 'connecting' | 'error' | 'idle'

/** One account row of `/dsh-mail/state`. */
export interface MailAccountView {
  readonly id: string
  readonly name: string
  readonly address: string
  readonly status: AccountStatus
  readonly lastError?: string
  /**
   * The last ALERT text this account's server sent.
   *
   * RFC 2683 §3.4.11: "Clients must present ALERT text clearly to the user".
   * The panel shows it next to the status line; it is not a connection error, so
   * it travels beside `lastError` rather than replacing it.
   */
  readonly alert?: string
  /** Where the last scan pass got to, so one that stalls is visible instead of silent. */
  readonly stage?: string
  readonly unread: number
}

/** One mailbox row of `/dsh-mail/state`. */
export interface MailboxView {
  readonly accountId: string
  readonly path: string
  readonly specialUse?: string
  readonly unseen: number
  readonly total: number
}

/** The parts of the configuration the panel is allowed to see (never the credential). */
export interface MailConfigView {
  readonly fallbackScanSeconds: number
  readonly maxListMessages: number
  /**
   * How many rows one account's window may hold, however many pages are loaded.
   *
   * The panel needs this to stop offering "load more" at the ceiling: past it the
   * list stops growing, and a button that does nothing reads as a broken fetch
   * rather than as the documented bound it is.
   */
  readonly maxWindowMessages: number
  readonly accounts: readonly MailAccount[]
  /**
   * How the reading pane treats remote images, and who is trusted.
   *
   * Read by the panel on every render rather than cached in the drawer: the
   * reading pane and the settings card have to agree about it, and they are two
   * halves of the same document.
   */
  readonly preferences: MailPreferences
}

/** `GET /dsh-mail/state`. */
export interface MailState {
  readonly version: 1
  /**
   * Bumped whenever anything the panel draws changes.
   *
   * The panel polls this route every couple of seconds. Without a cheap way to say
   * "nothing moved", every poll re-serialises the whole list — 35 KB for a hundred
   * rows, and it grows with the window. A caller that passes the revision it
   * already has gets `{ unchanged: true }` instead.
   */
  readonly revision: number
  readonly collectedAt: string
  /**
   * When the rows in `messages` were read from the mailbox.
   *
   * The panel draws the remembered list the moment the plugin starts and a scan
   * replaces it shortly after, so right after a restart this is older than
   * `collectedAt`. Absent when there is nothing remembered yet.
   */
  readonly cacheAt?: string
  readonly accounts: readonly MailAccountView[]
  readonly mailboxes: readonly MailboxView[]
  readonly messages: readonly MailSummary[]
  readonly config: MailConfigView
}

/** `POST /dsh-mail/action`. */
export type MailAction =
  | {
      readonly op: 'markRead' | 'markUnread' | 'flag' | 'unflag' | 'delete'
      readonly accountId: string
      readonly folder: string
      readonly uids: readonly number[]
    }
  | {
      readonly op: 'move'
      readonly accountId: string
      readonly folder: string
      readonly uids: readonly number[]
      readonly targetFolder: string
    }

/** `POST /dsh-mail/config`. */
export type MailConfigRequest =
  | {
      readonly op: 'addAccount' | 'updateAccount'
      readonly account: Omit<MailAccount, 'id'> & { readonly id?: string }
      readonly password?: string
    }
  | { readonly op: 'removeAccount'; readonly accountId: string }
  | { readonly op: 'testAccount'; readonly accountId?: string; readonly draft?: DraftAccount }
  | { readonly op: 'setPreferences'; readonly preferences: { readonly loadRemoteImages: boolean } }
  /**
   * Add or remove one sender from the image whitelist.
   *
   * One address at a time rather than "here is the whole list": the panel's list
   * and the reading pane's "加入白名单" button both edit it, and a whole-list write
   * would let whichever clicked last drop the other's change.
   */
  | { readonly op: 'trustSender'; readonly address: string; readonly trusted: boolean }

/**
 * The one method this plugin calls on `ctx.console`, declared structurally.
 *
 * The workbench is an optional plugin: depending on its package for a type
 * would make "workbench absent" a compile-time problem instead of the normal
 * runtime case the contract already handles.
 */
export interface ConsoleNoticeLike {
  notify(notice: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
  }): Promise<unknown>
}

/** An account the panel is testing before it exists. */
export interface DraftAccount {
  readonly address: string
  readonly imapHost: string
  readonly imapPort: number
  readonly secure: boolean
  readonly password: string
}

/** The answer every mutating route gives. */
export type RouteResult =
  | {
      readonly ok: true
      readonly applied?: number
      readonly mailboxes?: number
      /** Rows a "load more" page added to the window. */
      readonly added?: number
      /** Whether the folder had nothing older left to give. */
      readonly exhausted?: boolean
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/* ─────────────────────────── what other plugins use ───────────────────── */

/**
 * The answer to "make sure this folder exists".
 *
 * A folder that is already there is a success, not a failure: the caller asked
 * for it to exist, and it does.
 */
export type FolderResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * The mail capabilities another plugin may use — `ctx.mail`.
 *
 * Verbs only, on purpose: a consumer asks for a folder list or hands over an
 * action, and never gets the connection itself. That keeps the IMAP session,
 * its credentials and its reconnect policy this plugin's business, and it is
 * why the service is optional in the Context — a deployment without this plugin
 * simply has no mail, which is a normal state rather than a broken one.
 */
export interface MailService {
  /** Snapshot of the configured accounts, with their trigger configs. */
  accounts(): readonly MailAccount[]
  /** List an account's folders, as the panel's tree shows them. */
  listMailboxes(accountId: string): Promise<readonly MailboxView[]>
  /** Create the folder unless it is already there; never throws. */
  ensureFolder(accountId: string, path: string): Promise<FolderResult>
  /** Run one action (markRead / flag / move / delete) over a set of UIDs. */
  applyAction(action: MailAction): Promise<RouteResult>
  /** Read one message with its body; undefined when it cannot be read. */
  fetchDetail(accountId: string, folder: string, uid: number): Promise<MailDetail | undefined>
}

/**
 * What `mail/received` carries.
 *
 * The body is a callback rather than a string because reading it is the one
 * expensive IMAP round trip in the whole path, and most messages are decided on
 * their headers: a listener pays for the fetch only when its own rule needs it.
 */
export interface MailReceivedPayload {
  readonly accountId: string
  readonly accountName: string
  readonly summary: MailSummary
  /** Read the message's text; at most one fetch, however often it is called. */
  readonly readBody: () => Promise<string>
}

/* ──────────────────────────── plugin configuration ────────────────────── */

/** Loader-row configuration. Accounts and triggers are the panel's business, not this. */
export interface Config {
  /** Bottom-of-the-barrel rescan interval, in seconds. Default 300. */
  readonly fallbackScanSeconds: number
  /** How many recent messages `/dsh-mail/state` carries. Default 100. */
  readonly maxListMessages: number
  /** Abort an IMAP command after this many seconds. Default 30. */
  readonly imapTimeoutSeconds: number
  /**
   * The triage engine's global switches.
   *
   * Nested rather than flattened so the rule file, a profile row and this
   * interface have one obvious mapping: `triage:` holds what the rule file
   * cannot (whether to act at all, how long to wait before acting, where the
   * repositories are).
   */
  readonly triage: TriageConfig
}
