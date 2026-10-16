/**
 * Raw mail into the shapes the panel and the trigger read.
 *
 * Everything here is a pure function over bytes: no socket, no clock beyond the
 * fallback for a missing date, no filesystem. The IMAP layer hands over one
 * FETCH result and gets back a list row (`toSummary`), a preview for the list
 * pass (`previewOf`) or the reading pane (`parseDetail`), so the parsing rules
 * live in one place and every half of the plugin sees the same message.
 *
 * `mailparser` ships no type declarations and no `@types` package publishes
 * them either, so its result is narrowed to the slice read below rather than
 * trusted wholesale.
 *
 * @module @free-lzj/dsh-mail/message
 */

// @ts-expect-error -- TS7016: mailparser publishes no declaration file, and there is no @types/mailparser.
// `expect-error` rather than `ignore` so the day mailparser ships types, the build says so.
import { simpleParser } from 'mailparser'
import type { MailAddress, MailAttachment, MailDetail, MailSummary } from './types.ts'

/** Length of the list preview, in characters. */
const SNIPPET_LENGTH = 200

/** Stand-in subject for a message the server reports without one. */
const NO_SUBJECT = '(无主题)'

/** Stand-in name for an attachment the parser reports without one. */
const NO_FILENAME = '(无文件名)'

/** Content type for an attachment whose own type the parser could not read. */
const OCTET_STREAM = 'application/octet-stream'

/** Reading-pane body cap in bytes, applied to the text and the HTML separately. */
const TEXT_LIMIT = 256 * 1024

/** The `\Seen` flag, as both imapflow and RFC 3501 spell it. */
const SEEN = '\\Seen'

/** The `\Flagged` flag. */
const FLAGGED = '\\Flagged'

/**
 * The slice of `simpleParser`'s answer this module reads.
 *
 * Field names follow mailparser; anything optional really can be missing for a
 * malformed message, which is why every read goes through `textOf`.
 */
interface ParsedMail {
  readonly subject?: string | undefined
  readonly from?: unknown
  readonly to?: unknown
  readonly cc?: unknown
  readonly date?: Date | undefined
  readonly text?: string | undefined
  readonly html?: string | false | undefined
  readonly attachments?: readonly ParsedAttachment[] | undefined
}

/** One entry of `simpleParser`'s attachment list. */
interface ParsedAttachment {
  readonly filename?: string | undefined
  readonly contentType?: string | undefined
  readonly size?: number | undefined
  readonly contentId?: string | undefined
  /** IMAP-style body part number, e.g. `2` or `2.1`; null for a single-part message. */
  readonly partId?: string | null | undefined
  readonly related?: boolean | undefined
}

/** A non-empty trimmed string, or undefined. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** One field of a value that may or may not be an object. */
function fieldOf(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * One envelope address in our shape.
 *
 * Accepts what the three sources actually produce: an imapflow envelope entry
 * (`{ name, address }`), a mailparser address object under `.value`, and the
 * bare string a malformed header degrades to.
 * @param input - the address as some layer reported it.
 * @returns an address, with `address: ''` when there was nothing to read.
 */
export function addressOf(input: unknown): MailAddress {
  if (typeof input === 'string') return { address: input.trim() }
  if (input === null || typeof input !== 'object') return { address: '' }
  const record = input as { name?: unknown; address?: unknown }
  const address = textOf(record.address) ?? ''
  const name = textOf(record.name)
  return name === undefined ? { address } : { name, address }
}

/**
 * A whole address header in our shape.
 *
 * Handles the three containers the sources use: a plain array (imapflow's
 * envelope), mailparser's `{ value: [...] }` wrapper, and a lone address that
 * was never a list. Entries without an address are dropped, so an absent
 * header yields `[]` and a caller decides what a missing sender means.
 * @param input - the header as some layer reported it.
 * @returns the addresses, in the order the header listed them.
 */
export function addressesOf(input: unknown): readonly MailAddress[] {
  const value = fieldOf(input, 'value')
  const list = Array.isArray(input) ? input : Array.isArray(value) ? value : [input]
  return list.map(addressOf).filter(address => address.address.length > 0)
}

/**
 * One line of plain text for the list, cut to fit.
 *
 * Whitespace collapses to single spaces first — a body's own line breaks and
 * indentation carry no meaning in a one-line preview — then the cut happens on
 * a word boundary. When the last boundary is more than half the preview back
 * (one long URL, or a CJK run with no spaces at all), the text is cut mid-word
 * instead of returning a handful of characters.
 * @param text - the plain text to shorten.
 * @param max - the longest preview to return, in characters.
 * @returns the preview, ending in `…` when it was cut.
 */
export function snippetOf(text: string, max: number = SNIPPET_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const boundary = cut.lastIndexOf(' ')
  const head = boundary >= max / 2 ? cut.slice(0, boundary) : cut
  return `${head.trimEnd()}…`
}

/**
 * Whether a fetched flag set means "not read yet".
 * @param flags - the flags imapflow reported for one message.
 * @returns true when the message still counts as unread.
 */
export function isUnseen(flags: ReadonlySet<string>): boolean {
  return !flags.has(SEEN)
}

/**
 * Whether a fetched flag set means "starred".
 * @param flags - the flags imapflow reported for one message.
 * @returns true when the message carries `\Flagged`.
 */
export function isFlagged(flags: ReadonlySet<string>): boolean {
  return flags.has(FLAGGED)
}

/**
 * The first candidate that is a real date, as ISO.
 *
 * A server may report `internalDate` as a string and an envelope may carry a
 * date the parser rejected, so both are tried and an unparseable one is
 * skipped rather than turned into `Invalid Date`.
 * @param candidates - dates to try, most trustworthy first.
 * @returns an ISO timestamp, falling back to the current time.
 */
function isoDate(...candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    const date = candidate instanceof Date ? candidate : new Date(candidate as string | number)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

/**
 * One FETCH result as a list row, without parsing the body.
 *
 * The two expensive answers — whether there are attachments and what the
 * preview says — are the caller's to produce, because a scan reads them from
 * the body structure and a capped slice of the source rather than from the
 * full message.
 * @param input - the fields one FETCH reported. `size` is accepted for callers
 *   that already have it; the list shape has no column for it.
 * @returns the list row.
 */
export function toSummary(input: {
  accountId: string
  folder: string
  uid: number
  uidValidity: number
  flags: ReadonlySet<string>
  envelope: unknown
  internalDate: unknown
  size: number | undefined
  hasAttachments: boolean
  preview: string
}): MailSummary {
  return {
    accountId: input.accountId,
    folder: input.folder,
    uid: input.uid,
    uidValidity: input.uidValidity,
    subject: textOf(fieldOf(input.envelope, 'subject')) ?? NO_SUBJECT,
    from: addressesOf(fieldOf(input.envelope, 'from'))[0] ?? { address: '' },
    date: isoDate(fieldOf(input.envelope, 'date'), input.internalDate),
    seen: !isUnseen(input.flags),
    flagged: isFlagged(input.flags),
    hasAttachments: input.hasAttachments,
    snippet: snippetOf(input.preview),
  }
}

/**
 * Shorten one string to a byte cap without leaving half a character behind.
 * @param value - the text to cap.
 * @param limit - the cap in bytes.
 * @returns the text, and whether it was cut.
 */
function clamp(value: string, limit: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= limit) return { text: value, cut: false }
  // The slice can end mid-character; the decoder turns that tail into U+FFFD.
  return { text: bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/, ''), cut: true }
}

/**
 * The plain-text preview of a message source, for the list pass.
 *
 * A scan fetches only the head of each message, so this parses that slice: the
 * headers are enough to build the row, and the body is cut off long before the
 * list needs more than a line of it.
 * @param source - the fetched message head, as bytes or text.
 * @param max - the longest preview to return, in characters.
 * @returns the preview, empty when the source carried no readable text.
 */
export async function previewOf(source: Buffer | string, max: number = SNIPPET_LENGTH): Promise<string> {
  const parsed = await simpleParser(source) as ParsedMail | undefined
  return snippetOf(parsed?.text ?? '', max)
}

/**
 * One full source as the reading pane's shape.
 *
 * `text` and `html` are each capped independently, and any cut raises
 * `truncated`: the panel shows the cap notice rather than a silently short
 * body. HTML is handed over as the sender wrote it — rendering it safely is
 * the panel's sandboxed iframe's job, not this module's.
 * @param input - the source, the row it belongs to, and an optional cap.
 * @returns the message with its body and attachment list.
 */
export async function parseDetail(input: {
  source: Buffer | string
  summary: MailSummary
  maxTextBytes?: number
}): Promise<MailDetail> {
  const parsed = await simpleParser(input.source) as ParsedMail | undefined
  const limit = input.maxTextBytes ?? TEXT_LIMIT
  const text = clamp(parsed?.text ?? '', limit)
  const html = typeof parsed?.html === 'string' ? clamp(parsed.html, limit) : undefined

  const attachments: readonly MailAttachment[] = (parsed?.attachments ?? []).map((attachment, index) => ({
    // `partId` is the parser's IMAP-style body part number, which is exactly
    // what `download()` asks the server for; `contentId` is *not* a section and
    // a server rejects it, so it only stands in for a message the parser could
    // not number, and the plain index only for a structure neither reported.
    part: textOf(attachment.partId) ?? textOf(attachment.contentId) ?? String(index),
    filename: textOf(attachment.filename) ?? NO_FILENAME,
    contentType: textOf(attachment.contentType) ?? OCTET_STREAM,
    size: typeof attachment.size === 'number' ? attachment.size : 0,
  }))

  return {
    ...input.summary,
    subject: textOf(parsed?.subject) ?? input.summary.subject,
    from: addressesOf(parsed?.from)[0] ?? input.summary.from,
    date: isoDate(parsed?.date, input.summary.date),
    to: addressesOf(parsed?.to),
    cc: addressesOf(parsed?.cc),
    text: text.text,
    ...(html === undefined ? {} : { html: html.text }),
    attachments,
    truncated: text.cut || (html?.cut ?? false),
  }
}
