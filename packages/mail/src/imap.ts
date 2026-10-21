/**
 * The IMAP half: one connection per account, one incremental scan per folder,
 * and the write operations the panel's buttons ask for.
 *
 * Three rules shape everything here.
 *
 * **Everything is a UID.** Sequence numbers shift the moment a message is
 * deleted, so every search, fetch and store carries `{ uid: true }` as its last
 * argument; without it the server applies the range to sequence numbers and a
 * triage button silently rewrites a different message than the one the panel
 * showed.
 *
 * **Nothing is expunged.** `delete` moves a message to the trash when the
 * server keeps one, and only sets `\Deleted` when it does not. Expunging is
 * irreversible and stays the mail client's decision.
 *
 * **The library owns IDLE.** `ImapFlow` enters IDLE on its own after
 * `autoIdleDelay` and emits `exists`; this module listens and reconnects, and
 * never runs a polling loop of its own. Whatever cadence the caller wants on
 * top of that is the caller's business.
 *
 * The client is injected (`ImapFactory`) so the whole module is testable
 * without a socket.
 *
 * @module @free-lzj/dsh-mail/imap
 */

import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import type {
  AccountStatus, DraftAccount, FolderResult, MailAccount, MailAction, MailAttachment, MailDetail, MailboxView,
  NormalizedMessage, RouteResult,
} from './types.ts'
import { type MailPart, parseDetail, previewOf, snippetOf, toSummary, addressesOf } from './message.ts'

/** Version reported in the RFC 2971 ID command, next to the plugin's own name. */
const CLIENT_VERSION = '0.1.0'

/**
 * The one folder this plugin watches; IDLE only reports the selected mailbox.
 *
 * Every other folder is listed but never announced, so the resident connection
 * selects exactly this one and leaves it selected.
 */
export const WATCHED_FOLDER = 'INBOX'

/** Largest range one write operation may address, matching the route's own limit. */
const MAX_ACTION_UIDS = 500

/**
 * Bytes of each message a scan pulls for the list's one-line preview.
 *
 * A partial fetch rather than the whole body: a preview is cut to 200 characters
 * anyway, so a couple of kilobytes is all it can use. The first guess here was
 * 64 KB, and that made a first sync of a hundred messages drag for minutes —
 * six megabytes of body for text that never gets shown.
 */
const PREVIEW_MAX_BYTES = 2 * 1024

/**
 * Longest single body part the reading pane will download.
 *
 * The bound is on *a part*, not on the message, and that is the whole point. What
 * used to be capped was the RFC822 source, so a message whose body was seventy
 * kilobytes and whose PDF was three megabytes came back cut through the middle,
 * and the pane announced a truncated body it had in fact received in full.
 * Attachments are not fetched at all any more — they stream when they are
 * clicked — and what is fetched is the words and the pictures the pane draws.
 * Sixteen megabytes of *body* is not a mail: a part that reaches this is one
 * whose beginning is shown, with the notice that says so.
 */
export const MAX_BODY_PART_BYTES = 16 * 1024 * 1024

/** First reconnect delay, doubling per attempt up to {@link BACKOFF_MAX_MS}. */
const BACKOFF_BASE_MS = 5_000

/** Ceiling for the exponential reconnect backoff. */
const BACKOFF_MAX_MS = 300_000

/**
 * How long one IDLE may last before the client re-issues it.
 *
 * RFC 2177 §3 advises terminating and re-issuing IDLE at least every 29 minutes
 * so the server does not log the session off; RFC 3501 §5.4 requires a server's
 * inactivity timeout to be at least 30 minutes, and RFC 2683 §3.1.2 says a client
 * need not poll more often than about 25. imapflow restarts IDLE at this interval.
 */
const MAX_IDLE_MS = 25 * 60 * 1000

/** A body part number as IMAP spells it: `2`, `2.1` — never `0`. */
const SECTION = /^[1-9]\d*(\.\d+)*$/

/**
 * What one message's head is asked for during a scan; see {@link scanFolder}.
 *
 * `source` is bounded to {@link PREVIEW_MAX_BYTES}: the list needs sender,
 * subject, date and flags (all from the envelope) plus a one-line preview, and
 * asking for whole bodies is what made a first sync take minutes.
 */
const SUMMARY_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  source: { maxLength: PREVIEW_MAX_BYTES },
} as const

/**
 * What the reading pane asks for first: everything about a message but its bytes.
 *
 * The structure is what makes the rest possible — it names the parts, their sizes
 * and their content ids, so a second command can ask for the handful of them that
 * a reader actually needs. The envelope travels with it because the row is built
 * from it, and the flags because opening a message is also when it is marked read.
 * Asking for the whole `source` here is what used to make every attachment cost
 * its bytes twice: once on the wire, once in the parser.
 */
const DETAIL_HEAD_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
} as const

/**
 * What it asks for second: the parts its body is made of, and nothing else.
 *
 * One command for all of them, because they are read together; each carries
 * {@link MAX_BODY_PART_BYTES} rather than `true`, since a cap is required before
 * the bytes are asked for (RFC 4549 §4.6) and this is the only one left.
 * @param sections - the parts the structure said the body is made of.
 * @returns the fetch query.
 */
function partsQuery(sections: readonly string[]): Record<string, unknown> {
  return {
    uid: true,
    bodyParts: sections.map(section => ({ key: section, start: 0, maxLength: MAX_BODY_PART_BYTES })),
  }
}

/** The slice of imapflow this module uses — injectable so tests never open a socket. */
export interface ImapClientLike {
  /** imapflow exposes the selected mailbox's counters here once a mailbox is open. */
  readonly mailbox?: {
    uidNext?: number
    exists?: number
    /** imapflow reports this as a BigInt (it is a 32-bit unsigned value). */
    uidValidity?: bigint | number
    highestModseq?: bigint
  } | undefined
  connect(): Promise<void>
  logout(): Promise<void>
  /** Ask the server to deliver anything it has been holding for the selected mailbox. */
  noop(): Promise<void>
  close(): void
  list(options?: unknown): Promise<readonly { path: string; specialUse?: string; flags?: ReadonlySet<string> }[]>
  /**
   * Create a mailbox, and subscribe to it.
   *
   * `created: false` is imapflow's answer for a mailbox the server says already
   * exists (RFC 5530 `ALREADYEXISTS`) — not an error. It answers `undefined`
   * when the session is not in an authenticated state at all.
   */
  mailboxCreate(path: string): Promise<{ path: string; created?: boolean } | undefined>
  status(path: string, query: unknown): Promise<{ messages?: number; unseen?: number } | false>
  getMailboxLock(path: string): Promise<{ release(): void }>
  search(query: unknown, options?: unknown): Promise<number[] | false | undefined>
  fetch(range: unknown, query: unknown, options?: unknown): AsyncGenerator<{
    uid: number
    flags?: Set<string>
    envelope?: unknown
    internalDate?: unknown
    size?: number
    source?: Buffer
    bodyStructure?: unknown
  }, unknown>
  fetchOne(seq: string, query: unknown, options?: unknown): Promise<{
    uid: number
    flags?: Set<string>
    envelope?: unknown
    internalDate?: unknown
    size?: number
    source?: Buffer
    bodyStructure?: unknown
    /** One entry per `bodyParts` section the server answered for, keyed by section. */
    bodyParts?: Map<string, Buffer>
  } | false | undefined>
  messageFlagsAdd(range: unknown, flags: string[], options?: unknown): Promise<boolean>
  messageFlagsRemove(range: unknown, flags: string[], options?: unknown): Promise<boolean>
  messageDelete(range: unknown, options?: unknown): Promise<boolean>
  messageMove(range: unknown, destination: string, options?: unknown): Promise<unknown>
  download(range: unknown, part?: string, options?: unknown): Promise<{ meta?: { filename?: string; contentType?: string }; content: NodeJS.ReadableStream }>
  on(event: string, listener: (...args: never[]) => void): unknown
}

/** Builds one client, real or fake. */
export type ImapFactory = (options: Record<string, unknown>) => ImapClientLike

/**
 * Thrown by the request-path methods when the account has no live connection.
 *
 * It carries `code`, so a caller that never imported this class can still tell
 * an offline account from a missing message by reading the field.
 */
export class MailOfflineError extends Error {
  /** Stable machine-readable reason, matching the route's error code. */
  readonly code = 'account_offline'

  /**
   * @param message - what is wrong with the connection, for the log.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MailOfflineError'
  }
}

/**
 * The connection options one account needs, for a probe as much as a real session.
 *
 * `clientInfo` is not decoration: QQ and 163 answer `EXAMINE` with `Unsafe
 * Login` when a client connects without sending the ID command, so a client
 * that omits it looks like an authentication failure to the user. Every timeout
 * is the caller's, since a scan and a button click want different patience.
 *
 * The return type carries an index signature on purpose: a caller may add
 * imapflow options of its own (a probe's `verifyOnly`, say) and the result is
 * still both a valid `ImapFlowOptions` and something an `ImapFactory` accepts.
 * @param host - IMAP host.
 * @param port - IMAP port.
 * @param secure - whether to open the connection over TLS.
 * @param user - account address, as the IMAP user name.
 * @param password - authorization code or app password; never logged.
 * @param timeoutSeconds - cap for connecting, greeting and each command.
 * @returns options for `ImapFlow`.
 */
function connectionOptions(
  host: string,
  port: number,
  secure: boolean,
  user: string,
  password: string,
  timeoutSeconds: number,
): ImapFlowOptions & Record<string, unknown> {
  const timeout = Math.max(1, Math.trunc(timeoutSeconds)) * 1000
  return {
    host,
    port,
    secure,
    auth: { user, pass: password },
    clientInfo: { name: 'dsh-mail', version: CLIENT_VERSION, vendor: 'free-lzj' },
    // The protocol log would land in the host's log, which is not the place for
    // a mailbox's contents.
    logger: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    maxIdleTime: MAX_IDLE_MS,
  }
}

/**
 * Build the real client.
 * @param account - the configured mailbox.
 * @param password - its authorization code or app password.
 * @param timeoutSeconds - cap for connecting, greeting and each command.
 * @param extra - further imapflow options, overriding the defaults above.
 * @returns a client that has not connected yet.
 */
export function defaultImapFactory(
  account: MailAccount,
  password: string,
  timeoutSeconds: number,
  extra?: Record<string, unknown>,
): ImapClientLike {
  const options = Object.assign(
    {},
    connectionOptions(account.imapHost, account.imapPort, account.secure, account.address, password, timeoutSeconds),
    extra ?? {},
  )
  // ImapFlow's own types are wider (optional fields, overloaded `on`) than the
  // slice this module uses; the cast is the seam, not a shortcut.
  return new ImapFlow(options) as unknown as ImapClientLike
}

/**
 * A factory bound to one account's credentials, for callers that already hold them.
 *
 * `ImapFactory` takes the connection options so a test can inspect them, which
 * would otherwise force every caller to write a closure that ignores them; this
 * one keeps the credentials out of the call sites instead.
 * @param account - the configured mailbox.
 * @param password - its authorization code or app password.
 * @param timeoutSeconds - cap for connecting, greeting and each command.
 * @returns a factory that connects to this account.
 */
export function imapFactoryFor(account: MailAccount, password: string, timeoutSeconds: number): ImapFactory {
  return options => defaultImapFactory(account, password, timeoutSeconds, options)
}

/** What one scan pass needs to know about a folder. */
export interface ScanOptions {
  readonly account: MailAccount
  readonly password: string
  readonly folder: string
  /** Start UID (inclusive); 1 means "everything". */
  readonly fromUid: number
  /**
   * Highest UID to look at, exclusive; absent means "no upper bound".
   *
   * This is what makes the pass walk *backwards*. An incremental scan asks for
   * everything above the cursor, but a window that already holds the newest N
   * messages has to ask a different question — "the newest N below this one" —
   * and the open-ended `from:*` range cannot express it.
   */
  readonly beforeUid?: number | undefined
  /** Highest UID the caller already processed, or 0. A change in uidValidity resets it. */
  readonly knownUidValidity: number
  readonly timeoutSeconds: number
  readonly maxMessages: number
  /**
   * UIDs the panel is already showing, whose flags are re-read in the same pass.
   *
   * An incremental scan only fetches what is new, so without this the rows the
   * user sees keep whatever read/star state they had when they first arrived —
   * reading a message on a phone would never show up here.
   */
  readonly refreshUids?: readonly number[] | undefined
}

/** What one scan pass found. */
export interface ScanOutcome {
  readonly messages: readonly NormalizedMessage[]
  readonly uidValidity: number
  /**
   * The highest UID the caller may now record as processed. A failed SEARCH
   * answers `fromUid - 1`, so storing it verbatim leaves the cursor where it
   * was instead of skipping mail.
   */
  readonly maxUid: number
  /** True when the server's SEARCH looked unreliable and we fell back to a client-side filter. */
  readonly searchUnreliable: boolean
  /** Re-read flags for the UIDs the caller asked to refresh, in the same pass. */
  readonly refreshed: readonly MailFlagUpdate[]
  /**
   * UIDs the caller asked to refresh that the server did not report.
   *
   * A message the server no longer lists is gone: deleted on a phone, moved by a
   * filter, or expunged. Without this the panel keeps showing it forever — there
   * is nothing else in the protocol that tells us.
   */
  readonly vanished: readonly number[]
  /**
   * The folder's own counters as of this pass.
   *
   * The panel's folder tree needs these, and they are the server's numbers
   * rather than a count over the snapshot: a mailbox holding 51 messages can
   * report 3 unread while the window the panel keeps holds none, and both
   * numbers are correct about different things.
   */
  readonly counters: { readonly total: number; readonly unseen: number }
}

/** The read and star state of one message the plugin has already listed. */
export interface MailFlagUpdate {
  readonly uid: number
  readonly seen: boolean
  readonly flagged: boolean
}

/**
 * A UID or UIDVALIDITY as a plain number.
 *
 * imapflow reports UIDVALIDITY as a BigInt, and a BigInt that reaches
 * `JSON.stringify` throws — which fails the whole state response, so the panel
 * shows nothing at all rather than just that one field.
 * @param value - what the server said, if anything.
 * @returns the value as a number, or undefined when it is not a usable count.
 */
function asCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return undefined
}

/** One folder's counters, as much of them as this module reads. */
interface FolderStatus {
  readonly messages: number
  readonly unseen: number
  readonly uidValidity: number | undefined
}

/**
 * Re-read the read/star state of messages the plugin has already listed, and
 * report the ones the server no longer holds.
 *
 * Deliberately not folded into the new-mail pass: that pass answers "what
 * arrived", this one answers "what changed while we were not looking". Without
 * it a message read on a phone would stay bold here forever, because an
 * incremental scan never revisits a UID it has already handed over.
 *
 * The second half of the answer is the deletion detector. A UID FETCH of a UID
 * the server no longer lists simply says nothing about it — no error, no
 * marker — so "asked for it, got nothing back" is the only signal IMAP gives
 * that a message was deleted or moved elsewhere.
 * @param client - a connected client whose folder is already selected.
 * @param uids - the messages to re-read.
 * @returns one entry per message the server answered for, and the UIDs it did not.
 */
async function refreshFlags(client: ImapClientLike, uids: readonly number[]): Promise<{ updated: MailFlagUpdate[]; vanished: number[] }> {
  const updated: MailFlagUpdate[] = []
  const returned = new Set<number>()
  for await (const message of client.fetch([...uids], { uid: true, flags: true }, { uid: true })) {
    if (!Number.isSafeInteger(message.uid)) continue
    returned.add(message.uid)
    const flags = message.flags ?? new Set<string>()
    updated.push({ uid: message.uid, seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged') })
  }
  return { updated, vanished: uids.filter(uid => !returned.has(uid)) }
}

/** One field of a value that may or may not be an object. */
function fieldOf(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  return (source as Record<string, unknown>)[key]
}

/** A non-empty trimmed string, or undefined for anything else. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Describe any thrown value for a log line or an error code. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A folder's counters, or zeroes when the server will not answer.
 *
 * Only for a mailbox this session has **not** selected. RFC 3501 §6.3.10 says
 * STATUS SHOULD NOT be used on the selected mailbox and MUST NOT be used as a
 * "check for new messages" operation at all: its answer is not synchronized
 * with the session's own view of that mailbox, so it can report an unread count
 * the SELECTed session cannot see. The folder being scanned gets its numbers
 * from the session instead; this one is left for the folders a LIST just
 * enumerated and nothing has selected (RFC 2683 §3.1.1).
 *
 * `uidValidity` is read from the same STATUS, which is why the query asks for
 * it: a mailbox the server rebuilds gets a new value, and the caller uses the
 * change to drop its cursor rather than treating every old message as new.
 * @param client - the connected client.
 * @param path - the unselected mailbox to ask about.
 * @returns the counters, with `uidValidity` undefined when unavailable.
 */
async function folderStatus(client: ImapClientLike, path: string): Promise<FolderStatus> {
  let raw: unknown
  try {
    raw = await client.status(path, { messages: true, unseen: true, uidValidity: true })
  } catch {
    // A mailbox that cannot be measured is not a reason to fail the scan.
    return { messages: 0, unseen: 0, uidValidity: undefined }
  }
  if (raw === false || raw === null || typeof raw !== 'object') return { messages: 0, unseen: 0, uidValidity: undefined }
  const messages = fieldOf(raw, 'messages')
  const unseen = fieldOf(raw, 'unseen')
  const uidValidity = fieldOf(raw, 'uidValidity')
  return {
    messages: typeof messages === 'number' ? messages : 0,
    unseen: typeof unseen === 'number' ? unseen : 0,
    uidValidity: asCount(uidValidity),
  }
}

/**
 * Whether a body structure contains anything but the message's own text.
 *
 * A scan must answer this without downloading the body, so it reads the
 * structure only: a part declared `attachment`, a leaf that is not text and not
 * itself a container (an inline image, typically), or any part carrying a file
 * name. The heuristic can miss an unnamed, untyped leaf; the cost of that is a
 * missing paperclip in the list, not a wrong message.
 * @param structure - the `bodyStructure` imapflow reported.
 * @returns true when the message carries an attachment.
 */
function hasAttachmentsOf(structure: unknown): boolean {
  if (structure === null || typeof structure !== 'object') return false
  const disposition = fieldOf(structure, 'disposition')
  if (typeof disposition === 'string' && disposition.toLowerCase().includes('attachment')) return true
  const named = fieldOf(structure, 'dispositionParameters')
  if (fieldOf(named, 'filename') !== undefined) return true
  const parameters = fieldOf(structure, 'parameters')
  if (fieldOf(parameters, 'name') !== undefined) return true

  const children = fieldOf(structure, 'childNodes')
  if (Array.isArray(children) && children.length > 0) return children.some(hasAttachmentsOf)

  const type = fieldOf(structure, 'type')
  if (typeof type !== 'string' || type.length === 0) return false
  return !type.toLowerCase().startsWith('text/') && !type.toLowerCase().startsWith('multipart/')
}

/** Stand-in name for an attachment whose structure reports none. */
const NO_FILENAME = '(无文件名)'

/** Content type for a part whose structure reports none. */
const OCTET_STREAM = 'application/octet-stream'

/** One node of the tree `bodyStructure` reports, as much of it as this module reads. */
interface StructureNode {
  /** IMAP section number; absent on the root of a message that is not multipart. */
  readonly part?: string | undefined
  readonly type?: string | undefined
  readonly parameters?: Readonly<Record<string, string>> | undefined
  readonly disposition?: string | undefined
  readonly dispositionParameters?: Readonly<Record<string, string>> | undefined
  /** `Content-ID`, for a part an HTML body names. */
  readonly id?: string | undefined
  /** `Content-Transfer-Encoding`, which the part has to be read back with. */
  readonly encoding?: string | undefined
  readonly size?: number | undefined
  readonly childNodes?: readonly StructureNode[] | undefined
}

/** One part worth asking the server for, before its bytes exist. */
interface PartPlan {
  readonly section: string
  readonly type: string
  readonly parameters?: Readonly<Record<string, string>> | undefined
  readonly encoding?: string | undefined
  /** Set only on a part the HTML names by content id. */
  readonly cid?: string | undefined
  readonly size?: number | undefined
  /** True when this part is the whole message rather than one of a multipart. */
  readonly root?: boolean | undefined
}

/** What one message's structure says about the parts its reader needs. */
export interface MessageLayout {
  readonly text: readonly PartPlan[]
  readonly html: readonly PartPlan[]
  readonly inline: readonly PartPlan[]
  readonly attachments: readonly MailAttachment[]
}

/**
 * Whether a leaf is the message's own body, and which half of it.
 *
 * The rule is the one the parser applies to the same tree: a body part has no
 * `Content-Disposition`, or an inline one. `Content-Disposition: attachment` on a
 * `text/plain` part is a `.txt` the sender attached, and handing it to the pane
 * as the message would show a file as the mail.
 * @param node - one leaf of the structure.
 * @returns which body it is, or undefined when it is a file.
 */
function bodyKindOf(node: StructureNode): 'text' | 'html' | undefined {
  const type = (node.type ?? '').toLowerCase()
  if (type !== 'text/plain' && type !== 'text/html') return undefined
  const disposition = (node.disposition ?? '').toLowerCase()
  if (disposition !== '' && disposition !== 'inline') return undefined
  return type === 'text/html' ? 'html' : 'text'
}

/** One leaf as a plan for fetching it. */
function planOf(node: StructureNode): PartPlan {
  // A non-multipart message has no part numbers at all: RFC 3501 §6.4.5 gives it
  // exactly one part, and `1` addresses it — on the wire and in the download
  // route's section check alike.
  const number = textOf(node.part)
  const section = number ?? '1'
  const encoding = textOf(node.encoding)
  return {
    section,
    type: textOf(node.type) ?? OCTET_STREAM,
    ...(node.parameters === undefined ? {} : { parameters: node.parameters }),
    ...(encoding === undefined ? {} : { encoding }),
    ...(typeof node.size === 'number' ? { size: node.size } : {}),
    // No number means the structure described one part, not a tree — which the
    // assembled body has to keep saying, or the parser reads an HTML-only body
    // differently from the way it read the message it came from.
    ...(number === undefined ? { root: true } : {}),
  }
}

/** The attachment a leaf describes, for the list the pane draws. */
function attachmentOf(node: StructureNode, plan: PartPlan): MailAttachment {
  const filename = textOf(node.dispositionParameters?.['filename']) ?? textOf(node.parameters?.['name'])
  return {
    part: plan.section,
    filename: filename ?? NO_FILENAME,
    contentType: plan.type,
    size: plan.size ?? 0,
  }
}

/**
 * Read one message's structure into the parts its reader needs.
 *
 * This is what makes opening a message cost its body rather than its size: the
 * structure already describes every part — how big it is, what it is, what it is
 * called — so the attachment list is built without downloading an attachment,
 * and the fetch that follows asks only for the words and the pictures.
 *
 * A `message/rfc822` part is left at its wrapper: an attached mail is one
 * attachment, and walking into it would hand the pane the attached message's body
 * as if it were this one's.
 * @param structure - the `bodyStructure` imapflow reported.
 * @returns the parts to fetch, and the attachment list to draw.
 */
export function layoutOf(structure: unknown): MessageLayout {
  const text: PartPlan[] = []
  const html: PartPlan[] = []
  const inline: PartPlan[] = []
  const attachments: MailAttachment[] = []

  const visit = (raw: unknown): void => {
    if (raw === null || typeof raw !== 'object') return
    const node = raw as StructureNode
    const children = node.childNodes
    const encapsulated = (node.type ?? '').toLowerCase() === 'message/rfc822'
    if (Array.isArray(children) && children.length > 0 && !encapsulated) {
      for (const child of children) visit(child)
      return
    }
    const plan = planOf(node)
    const kind = bodyKindOf(node)
    if (kind === undefined) {
      const cid = textOf(node.id)
      if (cid !== undefined) inline.push({ ...plan, cid })
      attachments.push(attachmentOf(node, plan))
      return
    }
    if (kind === 'html') html.push(plan)
    else text.push(plan)
  }

  visit(structure)
  return { text, html, inline, attachments }
}

/**
 * One part's `Content-Type` as it is handed back to the parser.
 *
 * The parameters are half the part: `charset` is what turns the bytes into text,
 * and dropping it turns a GB18030 body into mojibake. `name` is left out on
 * purpose — a body part that carries a file name is one the parser files as an
 * attachment, which would lose the body it belongs to.
 * @param plan - the part.
 * @returns the header value.
 */
function contentTypeOf(plan: PartPlan): string {
  const parameters = Object.entries(plan.parameters ?? {})
    .filter(([key]) => key.toLowerCase() !== 'name')
    .map(([key, value]) => `${key}="${value.replace(/["\\]/g, '')}"`)
  return [plan.type, ...parameters].join('; ')
}

/**
 * The plans the server answered for, with their bytes.
 *
 * A section the server did not answer is dropped rather than faked: a part that
 * is gone is a part the pane does not show, and an empty one would render as a
 * blank image or an empty paragraph.
 * @param plans - what the structure said to fetch.
 * @param parts - what came back, keyed by section.
 * @returns the parts, or undefined when none of them arrived.
 */
function materialize(plans: readonly PartPlan[], parts: ReadonlyMap<string, Buffer> | undefined): MailPart[] | undefined {
  if (parts === undefined) return undefined
  const built = plans.flatMap((plan): MailPart[] => {
    const content = parts.get(plan.section) ?? parts.get(plan.section.toUpperCase())
    if (content === undefined) return []
    return [{
      contentType: contentTypeOf(plan),
      content,
      ...(plan.encoding === undefined ? {} : { encoding: plan.encoding }),
      ...(plan.cid === undefined ? {} : { cid: plan.cid }),
      ...(plan.root === true ? { root: true } : {}),
    }]
  })
  return built.length === 0 ? undefined : built
}

/**
 * One pass over a folder, on a connection the caller already owns.
 *
 * The caller keeps the connection (and its SELECTed mailbox) alive; this function
 * only takes a mailbox lock for the duration of the pass. A scan that opened its
 * own connection would be a second session on the same mailbox — see RFC 2683
 * §3.1.1 — and it would drop whatever the first session had selected, stopping
 * the server's change notifications.
 *
 * Everything this pass reads about the folder comes from that session: the
 * counters, the generation number and the UIDNEXT that decides whether there is
 * anything to ask for. STATUS is never sent about the folder being scanned — the
 * session's own view is the only one guaranteed to agree with itself (RFC 3501
 * §6.3.10, RFC 2683 §3.1.1).
 *
 * The lock is held across the search and the fetch so no other command shifts
 * the mailbox underneath them.
 *
 * Two server behaviours are handled rather than trusted. A SEARCH that answers
 * `false` (a connection or server problem) leaves the cursor exactly where the
 * caller had it. A SEARCH that answers an empty list for a mailbox the session
 * says is not empty is treated as an unreliable SEARCH on a first pass, and the
 * folder is enumerated by UID instead, which is linear but correct.
 * @param client - a connected client. The caller owns its lifecycle.
 * @param options - what to look at.
 * @returns what was found.
 */
export async function scanFolder(client: ImapClientLike, options: ScanOptions): Promise<ScanOutcome> {
  const from = Math.max(1, Math.trunc(options.fromUid))
  // A failed pass must leave the cursor untouched: `fromUid - 1` is what the
  // caller had before it computed `from`.
  const unadvanced = from - 1
  // Exclusive upper bound for a backwards pass. A window that inverts
  // (`before <= from`) is empty and is answered without a command: `UID SEARCH
  // 1:0` is a malformed range, not an empty one, and some servers answer BAD.
  const before = options.beforeUid === undefined
    ? undefined
    : Math.max(1, Math.trunc(options.beforeUid))

  // The SELECT this connection holds has already answered which generation the
  // folder is (UIDVALIDITY). Its UIDNEXT is deliberately not used to decide
  // whether anything arrived: imapflow only advances that number on a SELECT, a
  // STATUS or a FETCH that carries a UID, while the EXISTS a new message sends to
  // an idling session moves `exists` and leaves `uidNext` where it was (imapflow
  // `tools.js`, `case 'uid'`). Trusting the stale value is not a missed
  // optimisation but a missed message: a connection that has been open since
  // before the mail arrived would gate every pass away, and the refresh button
  // rides the same connection.
  //
  // imapflow hands UIDVALIDITY back as a BigInt; everything downstream stores
  // plain numbers, and a BigInt reaching JSON.stringify fails the whole response.
  const uidValidity = asCount(client.mailbox?.uidValidity) ?? options.knownUidValidity

  const lock = await client.getMailboxLock(options.folder)
  try {
    // Dovecot (and others) answer STATUS and FETCH for a mailbox this connection
    // has SELECTed from that connection's *own* view: only a NOOP, IDLE or another
    // SELECT delivers the untagged EXISTS/EXPUNGE/VANISHED that move it forward
    // (RFC 3501 §6.1.2). Mailspring's `noopSelectedFolder` exists for the same
    // reason, so a pass starts by asking the server to catch us up.
    await client.noop()
    // The counters come from the same session, so the folder tree and the list
    // can never disagree: EXISTS is the SELECT's own number, and the unread
    // count is a UID SEARCH over that same mailbox (RFC 2683 §3.2.1.2) instead
    // of a STATUS that describes some other instant.
    const unseen = await client.search({ unseen: true }, { uid: true })
    const counters = {
      total: client.mailbox?.exists ?? 0,
      unseen: unseen === false || unseen === undefined ? 0 : unseen.length,
    }

    // Same connection, same mailbox: re-reading the flags of what is already on
    // screen costs one FETCH and is what keeps the panel from showing a message
    // as unread long after it was read somewhere else. The same answer names the
    // rows the server no longer has. This runs before the new-mail gate below on
    // purpose: a mailbox with nothing new is exactly the case where a message
    // read on a phone has to stop being bold here.
    const refreshUids = options.refreshUids ?? []
    const refresh = refreshUids.length === 0 ? undefined : await refreshFlags(client, refreshUids)
    const refreshed = refresh?.updated ?? []
    const vanished = refresh?.vanished ?? []

    // The range is open-ended because that is the only bound the server can be
    // held to: `*` means "the last message" rather than "the last UID"
    // (RFC 3501 §9), so a mailbox whose highest UID is below `from` answers with
    // that last message too — the `uid >= from` filter below is what reads the
    // answer, and without it this becomes "forever new mail" (RFC 3501 §6.4.8
    // Note). One SEARCH per pass is the price of a cursor the server agrees with.
    //
    // `beforeUid` closes the range instead, which is how a backwards pass asks
    // for "the newest N below what I already hold". An empty window answers
    // without a command.
    if (before !== undefined && before <= from) {
      return { messages: [], uidValidity, maxUid: unadvanced, searchUnreliable: false, refreshed, vanished, counters }
    }
    const range = before === undefined ? `${String(from)}:*` : `${String(from)}:${String(before - 1)}`
    const found = await client.search({ uid: range }, { uid: true })
    if (found === false || found === undefined) {
      // `maxUid: fromUid - 1`: the command listed nothing, so nothing may be
      // recorded as seen.
      return { messages: [], uidValidity, maxUid: unadvanced, searchUnreliable: false, refreshed, vanished, counters }
    }

    let searchUnreliable = false
    let uids = found
    if (uids.length === 0 && counters.total > 0 && from <= 1) {
      // SEARCH says "nothing" while the mailbox says "plenty": enumerate
      // instead. UIDs only — the bodies are fetched in the bounded pass below.
      // The same range is used, so the fallback cannot walk past a backwards
      // window's upper bound either.
      searchUnreliable = true
      const everything: number[] = []
      for await (const message of client.fetch(range, { uid: true }, { uid: true })) {
        if (Number.isSafeInteger(message.uid)) everything.push(message.uid)
      }
      uids = everything
    }

    // Newest N, not oldest N. When a pass is chasing a mailbox that ran on
    // without the plugin (a long offline stretch), the interesting half is the
    // one the user can still see; taking the oldest would walk a 5000-message
    // backlog 100 messages at a time and hand every one of them to the
    // trigger on the way. `.slice(-0)` is `slice(0)` — the whole array — so a
    // zero cap is its own case. A backwards window reads the same way: "the N
    // closest to what the caller already holds" is exactly the page it asked for.
    const limit = Math.max(0, Math.trunc(options.maxMessages))
    const inWindow = (uid: number): boolean =>
      Number.isSafeInteger(uid) && uid >= from && (before === undefined || uid < before)
    const batch = limit === 0
      ? []
      : [...new Set(uids)]
        .filter(inWindow)
        .sort((a, b) => a - b)
        .slice(-limit)
    if (batch.length === 0) {
      return { messages: [], uidValidity, maxUid: unadvanced, searchUnreliable, refreshed, vanished, counters }
    }

    const messages: NormalizedMessage[] = []
    let maxUid = unadvanced
    for await (const message of client.fetch(batch, SUMMARY_QUERY, { uid: true })) {
      // The server answers the batch it was given, but a row outside the window
      // must never enter the snapshot: it would be a message the caller asked
      // not to see. `uid < before` is what keeps a backwards page a page.
      if (!Number.isSafeInteger(message.uid) || !inWindow(message.uid)) continue
      // Only the head of the body was fetched, which is what a preview needs.
      const preview = message.source === undefined ? '' : await previewOf(message.source)
      const summary = toSummary({
        accountId: options.account.id,
        folder: options.folder,
        uid: message.uid,
        uidValidity,
        flags: message.flags ?? new Set<string>(),
        envelope: message.envelope,
        internalDate: message.internalDate,
        size: message.size,
        hasAttachments: hasAttachmentsOf(message.bodyStructure),
        preview,
        source: message.source,
      })
      messages.push({ summary, preview: summary.snippet })
      if (message.uid > maxUid) maxUid = message.uid
    }
    return { messages, uidValidity, maxUid, searchUnreliable, refreshed, vanished, counters }
  } finally {
    // The lock is this pass's own — it is released even when the pass throws,
    // because the connection outlives the pass and must be left SELECTed.
    lock.release()
    // …and left SELECTed on the folder IDLE announces for. `getMailboxLock` keeps
    // whatever mailbox the last command selected, and IDLE only reports the
    // selected one (RFC 2177 §3), so a pass over another folder — which is what
    // every "load more" page is — would leave the account quietly watching the
    // wrong mailbox: new INBOX mail would stop arriving until some later pass
    // happened to switch it back.
    if (options.folder !== WATCHED_FOLDER) {
      try {
        const restore = await client.getMailboxLock(WATCHED_FOLDER)
        restore.release()
      } catch {
        // Failing to restore must not fail a page the caller already holds; the
        // next scan reselects and reports whatever is actually wrong.
      }
    }
  }
}

/** How the connection reports what happens to it. */
export interface ConnectionHandlers {
  readonly onNewMail?: (folder: string) => void
  /**
   * The server told us flags changed on a message we may be showing.
   *
   * This is the push half of flag synchronisation: RFC 3501 §5.2 has the server
   * volunteer these for the selected mailbox, so polling for them throws away
   * information the protocol already sent. Only emitted when the server named the
   * message; otherwise the caller is asked for a pass instead.
   */
  readonly onFlagsChange?: (updates: readonly MailFlagUpdate[]) => void
  /** A message was expunged and the server named its UID (QRESYNC does; plain EXPUNGE does not). */
  readonly onExpunge?: (uids: readonly number[]) => void
  readonly onStateChange?: (status: 'connecting' | 'connected' | 'error' | 'idle', error?: string) => void
  readonly onLog?: (message: string) => void
  /**
   * The server's ALERT text, which RFC 2683 §3.4.11 says a client must present
   * clearly to the user: a quota notice, a planned shutdown, a warning about the
   * account. imapflow surfaces it as an event; the caller is the only layer that
   * can put it in front of a human.
   */
  readonly onAlert?: (text: string) => void
}

/**
 * A long-lived connection whose whole job is to say "there may be new mail".
 *
 * The reading and writing methods use it too, so a panel click reuses the
 * session the events already keep open instead of paying for a new TLS login.
 */
export interface MailConnection {
  start(): Promise<void>
  stop(): Promise<void>
  status(): 'connecting' | 'connected' | 'error' | 'idle'
  lastError(): string | undefined
  listMailboxes(): Promise<readonly MailboxView[]>
  /**
   * Create a folder, unless the server already has one with that name.
   *
   * Answers rather than throws, because "the folder could not be created" is a
   * normal outcome a caller has to act on (offer the user the manual step),
   * not an exception. A folder that already exists is a success.
   * @param path - the mailbox path to create.
   * @returns the folder's final path, or why it could not be created.
   */
  mailboxCreate(path: string): Promise<FolderResult>
  /**
   * One scan pass over a folder, on this connection.
   *
   * Reuses the session instead of opening another one: the account's login, TLS
   * handshake and selected mailbox all stay where they are.
   * @param options - the folder and the cursor; the account's own details come
   * from the connection.
   * @returns what the pass found.
   */
  scan(options: Omit<ScanOptions, 'account' | 'password' | 'timeoutSeconds'>): Promise<ScanOutcome>
  fetchDetail(folder: string, uid: number): Promise<MailDetail | undefined>
  downloadAttachment(folder: string, uid: number, part: string): Promise<{ filename: string; contentType: string; content: NodeJS.ReadableStream } | undefined>
  applyAction(action: MailAction): Promise<RouteResult>
}

/**
 * Create one account's connection.
 *
 * The connection reconnects on its own with an exponential backoff, and stops
 * for good once `stop()` is called. `start()` never rejects: a mailbox that is
 * unreachable at boot is a state the panel shows, not an exception the plugin
 * has to survive.
 * @param factory - how to build a client.
 * @param account - the configured mailbox.
 * @param password - its authorization code or app password.
 * @param timeoutSeconds - cap for connecting, greeting and each command.
 * @param handlers - where new mail, state changes and log lines go.
 * @returns the connection.
 */
export function createConnection(
  factory: ImapFactory,
  account: MailAccount,
  password: string,
  timeoutSeconds: number,
  handlers: ConnectionHandlers = {},
): MailConnection {
  let client: ImapClientLike | undefined
  let state: AccountStatus = 'idle'
  let failure: string | undefined
  let stopped = false
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  /** The client, or the error every request-path method answers with. */
  const requireClient = (): ImapClientLike => {
    if (client === undefined) throw new MailOfflineError(`mailbox ${account.id} is not connected`)
    return client
  }

  const setState = (next: AccountStatus, error?: string): void => {
    if (error !== undefined) failure = error
    if (next === 'connected') failure = undefined
    if (state === next) return
    state = next
    handlers.onStateChange?.(next, failure)
  }

  const drop = (target: ImapClientLike | undefined): void => {
    if (target === undefined) return
    if (client === target) client = undefined
    try {
      target.close()
    } catch {
      // Closing an already-dead socket is not a failure worth reporting.
    }
  }

  /** Come back later, doubling the wait each time up to the ceiling. */
  const scheduleRetry = (reason: string): void => {
    if (stopped || retry !== undefined) return
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts)
    attempts += 1
    handlers.onLog?.(`mail: ${account.id} reconnect in ${String(Math.round(delay / 1000))}s (${reason})`)
    retry = setTimeout(() => {
      retry = undefined
      void open()
    }, delay)
  }

  const open = async (): Promise<void> => {
    if (stopped) return
    setState('connecting')
    const next = factory(connectionOptions(account.imapHost, account.imapPort, account.secure, account.address, password, timeoutSeconds))
    client = next
    next.on('exists', (event: unknown) => {
      const path = fieldOf(event, 'path')
      if (typeof path === 'string' && path.length > 0) handlers.onNewMail?.(path)
    })
    // Flags and expunges are volunteered by the server for the mailbox this
    // connection has selected (RFC 3501 §5.2). Applying them here is what makes a
    // message read on a phone stop being bold before the next poll — and it costs
    // no round trip, unlike re-reading the flags of everything on screen.
    next.on('flags', (event: unknown) => {
      const path = fieldOf(event, 'path')
      const uid = fieldOf(event, 'uid')
      const flags = fieldOf(event, 'flags')
      if (typeof path !== 'string' || path !== WATCHED_FOLDER) return
      if (typeof uid !== 'number' || !(flags instanceof Set)) {
        // Unnamed: only a pass can work out which row moved.
        handlers.onNewMail?.(path)
        return
      }
      const current = flags as Set<string>
      handlers.onFlagsChange?.([{ uid, seen: current.has('\\Seen'), flagged: current.has('\\Flagged') }])
    })
    next.on('expunge', (event: unknown) => {
      const path = fieldOf(event, 'path')
      const uid = fieldOf(event, 'uid')
      if (typeof path !== 'string' || path !== WATCHED_FOLDER) return
      // A plain EXPUNGE carries only a sequence number, and sequence numbers shift
      // with every expunge — resolving one to a UID would be a guess. Ask for a
      // pass instead; it sees the mailbox as it now is.
      if (typeof uid === 'number') handlers.onExpunge?.([uid])
      else handlers.onNewMail?.(path)
    })
    next.on('alert', (event: unknown) => {
      const message = fieldOf(event, 'message')
      if (typeof message === 'string' && message.length > 0) handlers.onAlert?.(message)
    })
    next.on('error', (error: unknown) => {
      const text = describe(error)
      drop(next)
      if (stopped) return
      setState('error', text)
      scheduleRetry(text)
    })
    next.on('close', () => {
      drop(next)
      if (stopped) return
      const text = failure ?? 'connection closed'
      setState('error', text)
      scheduleRetry(text)
    })

    try {
      await next.connect()
    } catch (error: unknown) {
      const text = describe(error)
      drop(next)
      if (stopped) return
      setState('error', text)
      scheduleRetry(text)
      return
    }
    if (stopped) {
      try {
        await next.logout()
      } catch {
        drop(next)
      }
      return
    }
    attempts = 0
    // Select the folder we watch, then release the lock: a selected mailbox is
    // what IDLE reports changes for, while holding the lock would stop auto-IDLE
    // from ever starting (imapflow only idles when no lock is held). Every
    // command below takes its own lock and releases it. This runs on the
    // reconnect path too, which is what re-syncs a mailbox whose EXPUNGEs
    // arrived while the socket was down.
    try {
      const lock = await next.getMailboxLock(WATCHED_FOLDER)
      lock.release()
    } catch (error: unknown) {
      // A mailbox we cannot select still leaves the account usable for listing
      // folders; the first scan reports the real problem.
      handlers.onLog?.(`mail: ${account.id} could not select ${WATCHED_FOLDER}: ${describe(error)}`)
    }
    setState('connected')
  }

  return {
    async start(): Promise<void> {
      stopped = false
      if (client !== undefined) return
      await open()
    },

    async stop(): Promise<void> {
      stopped = true
      if (retry !== undefined) {
        clearTimeout(retry)
        retry = undefined
      }
      const current = client
      client = undefined
      setState('idle')
      if (current === undefined) return
      try {
        await current.logout()
      } catch {
        drop(current)
      }
    },

    status: () => state,

    lastError: () => failure,

    async scan(options: Omit<ScanOptions, 'account' | 'password' | 'timeoutSeconds'>): Promise<ScanOutcome> {
      // `requireClient` rather than a fresh session: the account already holds a
      // connection, and a second one on the same mailbox is what RFC 2683 §3.1.1
      // tells clients to avoid.
      return await scanFolder(requireClient(), { ...options, account, password, timeoutSeconds })
    },

    async mailboxCreate(path: string): Promise<FolderResult> {
      if (client === undefined) {
        return { ok: false, code: 'account_offline', message: `mailbox ${account.id} is not connected` }
      }
      const current = client
      try {
        // imapflow subscribes to the new mailbox on the way out. A mailbox the
        // server says already exists comes back as `created: false` rather than
        // as a throw, which is exactly the "make sure it exists" contract.
        const created = await current.mailboxCreate(path)
        if (created === undefined) {
          return { ok: false, code: 'account_offline', message: `mailbox ${account.id} is not authenticated` }
        }
        return { ok: true, path: created.path }
      } catch (error: unknown) {
        const reason = describe(error)
        return isOffline(fieldOf(error, 'code'))
          ? { ok: false, code: 'account_offline', message: reason }
          : { ok: false, code: 'imap_rejected', message: reason }
      }
    },

    async listMailboxes(): Promise<readonly MailboxView[]> {
      if (client === undefined) return []
      const current = client
      const listed = await current.list()
      const views: MailboxView[] = []
      for (const entry of listed) {
        const status = await folderStatus(current, entry.path)
        views.push({
          accountId: account.id,
          path: entry.path,
          ...(entry.specialUse === undefined ? {} : { specialUse: entry.specialUse }),
          unseen: status.unseen,
          total: status.messages,
        })
      }
      return views
    },

    async fetchDetail(folder: string, uid: number): Promise<MailDetail | undefined> {
      const current = requireClient()
      const lock = await current.getMailboxLock(folder)
      let head: Awaited<ReturnType<ImapClientLike['fetchOne']>>
      let layout: MessageLayout
      let parts: ReadonlyMap<string, Buffer> | undefined
      let uidValidity = 0
      try {
        // The SELECT the lock just performed is where the generation number
        // comes from — the reading pane has no scan to inherit it from, and
        // asking STATUS about a mailbox this session has selected is what
        // RFC 3501 §6.3.10 tells clients not to do. It arrives as a BigInt.
        uidValidity = asCount(current.mailbox?.uidValidity) ?? 0
        head = await current.fetchOne(String(uid), DETAIL_HEAD_QUERY, { uid: true })
        if (head === false || head === undefined) return undefined
        // Two commands rather than one, and the second one is the small one: the
        // structure says which parts the body is made of, and only those are
        // asked for. This is what a message with a large attachment stops paying
        // for — its body is fetched, and the attachment waits for a click.
        layout = layoutOf(head.bodyStructure)
        const wanted = [...layout.text, ...layout.html, ...layout.inline].map(plan => plan.section)
        const answered = wanted.length === 0
          ? undefined
          : await current.fetchOne(String(uid), partsQuery(wanted), { uid: true })
        parts = answered === false || answered === undefined ? undefined : answered.bodyParts
      } finally {
        lock.release()
      }
      const summary = toSummary({
        accountId: account.id,
        folder,
        uid: head.uid,
        uidValidity,
        flags: head.flags ?? new Set<string>(),
        envelope: head.envelope,
        internalDate: head.internalDate,
        size: head.size,
        hasAttachments: layout.attachments.length > 0,
        preview: '',
        // Nothing on this path reads a triage header, and the head that carries
        // them is exactly what is not fetched here — see DETAIL_HEAD_QUERY.
        source: undefined,
      })
      const detail = await parseDetail({
        summary,
        to: addressesOf(fieldOf(head.envelope, 'to')),
        cc: addressesOf(fieldOf(head.envelope, 'cc')),
        // The list comes from the structure, never from a download: an
        // attachment that had to be fetched to be listed is an attachment the
        // pane paid for before the user asked for it.
        attachments: layout.attachments,
        parts: {
          text: materialize(layout.text, parts),
          html: materialize(layout.html, parts),
          inline: materialize(layout.inline, parts),
        },
      })
      // A part that came back at the cap — or one the structure already said was
      // bigger than one — was cut before the parser saw it, and the parser cannot
      // tell. The notice the pane draws is the only thing that says so.
      const cut = [...layout.text, ...layout.html, ...layout.inline].some((plan) => {
        const received = parts?.get(plan.section)?.byteLength ?? 0
        return received >= MAX_BODY_PART_BYTES || (plan.size ?? 0) > MAX_BODY_PART_BYTES
      })
      // The list row's preview and paperclip come from the parsed body once it is
      // in hand, which is more accurate than the structure's own guess.
      return {
        ...detail,
        truncated: cut,
        snippet: snippetOf(detail.text),
        hasAttachments: layout.attachments.length > 0,
      }
    },

    async downloadAttachment(folder: string, uid: number, part: string): Promise<{ filename: string; contentType: string; content: NodeJS.ReadableStream } | undefined> {
      // A token that is not an IMAP section (a content id, most likely) is
      // refused here: asking the server for `BODY[<abc@example>]` earns a BAD
      // response at best, and a wrong section would stream the wrong part.
      if (!SECTION.test(part)) return undefined
      const current = requireClient()
      const lock = await current.getMailboxLock(folder)
      try {
        const result = await current.download(String(uid), part, { uid: true })
        const content = result?.content
        if (content === undefined || content === null) return undefined
        // ponytail: the lock is released once the part is streaming, not when the
        // caller finishes reading it — the signature hands the stream over rather
        // than taking a consumer callback. A command that switches folders while a
        // download is in flight can cut it short; the panel downloads one
        // attachment at a time from the folder it is already reading.
        return {
          filename: result.meta?.filename ?? 'attachment',
          contentType: result.meta?.contentType ?? 'application/octet-stream',
          content,
        }
      } finally {
        lock.release()
      }
    },

    async applyAction(action: MailAction): Promise<RouteResult> {
      const uids = action.uids
      // The route hands the body straight over, so this is the last place the
      // range can be checked before it reaches a STORE.
      if (uids.length === 0 || uids.length > MAX_ACTION_UIDS || uids.some(uid => !Number.isSafeInteger(uid) || uid <= 0)) {
        return { ok: false, code: 'invalid_action', message: `uids must be 1..${String(MAX_ACTION_UIDS)} positive integers` }
      }
      if (client === undefined) {
        return { ok: false, code: 'account_offline', message: `mailbox ${account.id} is not connected` }
      }
      const current = client
      const options = { uid: true }
      /** Send the one command this operation is, with the UID option on it. */
      const send = async (): Promise<boolean> => {
        switch (action.op) {
          case 'markRead':
            return await current.messageFlagsAdd(uids, ['\\Seen'], options)
          case 'markUnread':
            return await current.messageFlagsRemove(uids, ['\\Seen'], options)
          case 'flag':
            return await current.messageFlagsAdd(uids, ['\\Flagged'], options)
          case 'unflag':
            return await current.messageFlagsRemove(uids, ['\\Flagged'], options)
          case 'delete':
            // Sets `\Deleted`; whether that means the trash or a pending
            // expunge is the server's decision. Never EXPUNGE it here.
            return await current.messageDelete(uids, options)
          case 'move':
            return (await current.messageMove(uids, action.targetFolder, options)) !== false
        }
      }
      try {
        const lock = await current.getMailboxLock(action.folder)
        try {
          if (!await send()) {
            return { ok: false, code: 'imap_rejected', message: `the server refused ${action.op} for ${String(uids.length)} message(s)` }
          }
          return { ok: true, applied: uids.length }
        } finally {
          lock.release()
        }
      } catch (error: unknown) {
        const reason = describe(error)
        return isOffline(fieldOf(error, 'code'))
          ? { ok: false, code: 'account_offline', message: reason }
          : { ok: false, code: 'imap_rejected', message: reason }
      }
    },
  }
}

/** Whether an imapflow error code means the connection, not the command, failed. */
function isOffline(code: unknown): boolean {
  if (typeof code !== 'string') return false
  return code === 'NoConnection'
    || code === 'EConnectionClosed'
    || code === 'StateLogout'
    || code === 'CONNECT_TIMEOUT'
    || code === 'ETIMEOUT'
    || /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ESOCKETTIMEDOUT)$/.test(code)
}

/**
 * Why a probe failed, in the panel's vocabulary.
 *
 * imapflow stamps `authenticationFailed` on a rejected login and `tlsFailed`
 * on a failed upgrade; anything else is the network. The text is a fallback for
 * the errors that arrive without either flag.
 * @param error - whatever the client threw.
 * @returns `auth_failed`, `tls_error` or `network_error`.
 */
function probeCode(error: unknown): string {
  if (fieldOf(error, 'authenticationFailed') === true) return 'auth_failed'
  if (fieldOf(error, 'tlsFailed') === true) return 'tls_error'
  return /auth|credential|password|login/i.test(describe(error)) ? 'auth_failed' : 'network_error'
}

/**
 * Connect, list the mailboxes, disconnect. Used by the panel's "test connection" button.
 *
 * Deliberately a plain connect rather than imapflow's `verifyOnly`: a verify-only
 * session logs out inside `connect()`, which is exactly the session that cannot
 * answer with a mailbox count.
 * @param factory - how to build a client.
 * @param draft - the account the panel is testing before it exists.
 * @param timeoutSeconds - cap for connecting, greeting and each command.
 * @returns how many mailboxes the login can see, or why it failed.
 */
export async function probeAccount(
  factory: ImapFactory,
  draft: DraftAccount,
  timeoutSeconds: number,
): Promise<{ ok: true; mailboxes: number } | { ok: false; code: string; message: string }> {
  const client = factory(connectionOptions(draft.imapHost, draft.imapPort, draft.secure, draft.address, draft.password, timeoutSeconds))
  try {
    await client.connect()
    const mailboxes = await client.list()
    return { ok: true, mailboxes: mailboxes.length }
  } catch (error: unknown) {
    return { ok: false, code: probeCode(error), message: describe(error) }
  } finally {
    try {
      await client.logout()
    } catch {
      // The session may already be gone, which is what a failed probe leaves.
      try {
        client.close()
      } catch {
        // Nothing left to close.
      }
    }
  }
}
