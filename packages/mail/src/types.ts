/**
 * The shapes every half of the mail plugin agrees on.
 *
 * Types live in one module because four independently written pieces have to
 * fit together: the account store, the IMAP scanner, the trigger, and the HTTP
 * surface the panel reads. Nothing here knows about imapflow, cordis or the DOM.
 *
 * @module @free-lzj/dsh-mail/types
 */

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
 */
export interface MailAccount {
  readonly id: string
  readonly name: string
  readonly address: string
  readonly provider: MailProvider
  readonly imapHost: string
  readonly imapPort: number
  readonly secure: boolean
  readonly trigger: TriggerConfig
}

/* ──────────────────────────────── trigger ─────────────────────────────── */

/** What happens when a new message matches the filters. */
export type TriggerMode = 'session' | 'notify' | 'panel'

/** Filters: groups are AND-ed, values inside one group are OR-ed, absent = unrestricted. */
export interface TriggerFilters {
  readonly from?: readonly string[]
  readonly subject?: readonly string[]
  readonly keywords?: readonly string[]
  /** Default true: only messages whose `\Seen` flag is absent are considered. */
  readonly unreadOnly?: boolean
}

/** Parameters for `mode: 'session'` — a new root session per matched message. */
export interface SessionTriggerOptions {
  /** Absolute path; the workspace the new session runs in. */
  readonly workspacePath: string
  /** Omitted = the deployment's current default agent preset. */
  readonly agentPreset?: string
  /** Omitted = the deployment's default permission preset. */
  readonly permissionPreset?: string
  /** Title template; `{subject}` and `{from}` are substituted. Default `邮件：{subject}`. */
  readonly titleTemplate?: string
}

/** Parameters for `mode: 'notify'` — deliver into an existing session. */
export interface NotifyTriggerOptions {
  readonly sessionId: string
}

/**
 * One rule: which messages it claims, and what happens to them.
 *
 * Conditions are the same shape as {@link TriggerFilters} — groups are AND-ed,
 * values inside a group are OR-ed — because that is the model the drawer already
 * draws and the one every mail client has converged on (Gmail's criteria,
 * Thunderbird's matchAll, Sieve's `allof`). Nesting is deliberately absent: a
 * flat conjunction covers the real cases, and a tree nobody can read in a form
 * is a worse editor than one nobody needs.
 */
export interface TriggerRule {
  /** Shown in the drawer so a list of rules can be told apart. */
  readonly name?: string
  /** Everything must hold; an absent group is unrestricted. */
  readonly when: TriggerFilters
  /** What this rule does with a message it claims. */
  readonly action: TriggerMode
  /** Parameters for `action: 'session'`; falls back to the account's own. */
  readonly session?: SessionTriggerOptions
  /** Parameters for `action: 'notify'`; falls back to the account's own. */
  readonly notify?: NotifyTriggerOptions
  /** Overrides the account's prompt template for messages this rule claims. */
  readonly promptTemplate?: string
}

/** How one account hands a matched message over. */
export interface TriggerConfig {
  readonly mode: TriggerMode
  readonly session?: SessionTriggerOptions
  readonly notify?: NotifyTriggerOptions
  /**
   * Rules, evaluated in order; the first one whose conditions all hold decides
   * what happens. A message no rule claims falls back to {@link mode}, so an
   * account can say "default to a session, except these".
   *
   * Omitted = the account's own `filters` and `mode` are the single rule, which
   * is every configuration written before rules existed.
   */
  readonly rules?: readonly TriggerRule[]
  /**
   * The text posted into the session when a message matches.
   *
   * `{from}`, `{subject}`, `{date}`, `{account}` and `{body}` are substituted;
   * any other `{name}` is left as written. Omitted = the built-in template,
   * which opens by saying the mail is external content rather than
   * instructions — an account that writes its own template takes that over.
   */
  readonly promptTemplate?: string
  readonly filters: TriggerFilters
}

/* ─────────────────────────────── messages ─────────────────────────────── */

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
  /** Plain text, truncated to the configured cap. */
  readonly text: string
  /** Raw HTML from the sender, truncated. The panel renders it in a sandboxed iframe. */
  readonly html?: string
  readonly attachments: readonly MailAttachment[]
  /** True when the source exceeded the fetch cap and a field was dropped or cut. */
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
  readonly accounts: readonly MailAccount[]
  /** Which trigger modes this deployment can actually run, so the drawer greys the rest out. */
  readonly triggerAvailability: { readonly session: boolean; readonly notify: boolean }
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
  | { readonly op: 'setTrigger'; readonly accountId: string; readonly trigger: TriggerConfig }

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
  | { readonly ok: true; readonly applied?: number; readonly mailboxes?: number }
  | { readonly ok: false; readonly code: string; readonly message: string }

/* ──────────────────────────── plugin configuration ────────────────────── */

/** Loader-row configuration. Accounts and triggers are the panel's business, not this. */
export interface Config {
  /** Bottom-of-the-barrel rescan interval, in seconds. Default 300. */
  readonly fallbackScanSeconds: number
  /** How many recent messages `/dsh-mail/state` carries. Default 100. */
  readonly maxListMessages: number
  /** Abort an IMAP command after this many seconds. Default 30. */
  readonly imapTimeoutSeconds: number
}
