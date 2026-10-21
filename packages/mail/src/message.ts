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
import { parseTriageHeaders } from './headers.ts'
import type { MailAddress, MailAttachment, MailDetail, MailSummary } from './types.ts'

/** Length of the list preview, in characters. */
const SNIPPET_LENGTH = 200

/** Stand-in subject for a message the server reports without one. */
const NO_SUBJECT = '(无主题)'

/** Content type for an attachment whose own type the parser could not read. */
const OCTET_STREAM = 'application/octet-stream'

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
  /** Content id without its angle brackets; what a `cid:` URL in the HTML names. */
  readonly cid?: string | undefined
  /** The decoded bytes, when the parser was asked to buffer them (it is, by default). */
  readonly content?: Buffer | undefined
}

/**
 * One MIME part as the server sent it, with what it takes to read it back.
 *
 * A part is fetched the way the sender stored it, bytes still in their transfer
 * encoding, so reproducing `Content-Type` and `Content-Transfer-Encoding` is how
 * {@link assembleOwnBody} hands the decoding to the one library that already
 * does it. Decoding here would mean re-implementing base64, quoted-printable and
 * a charset table — which is exactly where a hand-written mail reader breaks.
 */
export interface MailPart {
  /** The part's own `Content-Type`, parameters included. */
  readonly contentType: string
  /** The part's body octets, undecoded. */
  readonly content: Buffer
  /** `Content-Transfer-Encoding`, when the structure declared one. */
  readonly encoding?: string
  /** `Content-ID`, for the part an HTML body names. */
  readonly cid?: string
  /**
   * True when this part *was* the message rather than one part of a multipart.
   *
   * It decides whether the assembled body has one part or a tree, and it is not
   * a detail: a lone HTML part at the root is a body the parser turns into text
   * itself, while an HTML part inside a multipart is left as markup and read by
   * {@link textOfHtml}. Writing a multipart message as a single part would change
   * both the text a prompt receives and the bytes the pane renders.
   */
  readonly root?: boolean
}

/**
 * The parts one message's own body is made of, already fetched.
 *
 * `text` and `html` are lists because a message may carry several of either
 * (mailparser joins them, and so does the body assembled from here); `inline`
 * holds the parts the HTML names by content id, which is what turns `cid:` into
 * something the reading pane can draw.
 */
export interface OwnParts {
  readonly text?: readonly MailPart[] | undefined
  readonly html?: readonly MailPart[] | undefined
  readonly inline?: readonly MailPart[] | undefined
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
 * full message. The headers are not expensive: the scan already fetched them
 * inside `source`, and parsing them costs one walk over a couple of kilobytes.
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
  /** The fetched head, whose header section carries the triage headers. */
  source: string | Buffer | undefined
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
    headers: parseTriageHeaders(input.source),
  }
}

/**
 * One `cid:` reference as the key the attachment map is built with.
 *
 * A sender may write the content id percent-encoded, and the same id is
 * referenced with different case across the parts of one mail, so the lookup is
 * decoded and lowercased. A `%` that is not an escape is kept rather than
 * throwing: a malformed id means one broken image, not a broken message.
 * @param raw - what followed `cid:` in the HTML.
 * @returns the lookup key, or undefined when there is nothing to look up.
 */
function cidKey(raw: string): string | undefined {
  let value = raw.trim()
  try {
    value = decodeURIComponent(value)
  } catch {
    // Left as written.
  }
  const key = value.trim().toLowerCase()
  return key === '' ? undefined : key
}

/**
 * Put the parts a message references inline into its HTML, as `data:` URIs.
 *
 * A mail that attaches an image instead of embedding it is rendered by every
 * mail client (that is what `multipart/related` is for), but `cid:` is not a URL
 * a browser can resolve: without this the reading pane can only block it. The
 * bytes are already in hand — the whole source was parsed to get here — so
 * turning them into `data:` URIs costs nothing but the base64, and it keeps the
 * frame's policy untouched (no route to open, no origin to allow, no request to
 * make on behalf of a sender).
 *
 * Only references that resolve are replaced; a `cid:` naming a part the parser
 * did not hand over is left as written for the panel to block, which is what it
 * already does with every other foreign scheme.
 * @param html - the message's HTML part, as the sender wrote it.
 * @param attachments - everything the parser split off the message.
 * @returns the HTML, with resolvable `cid:` references inlined.
 */
function inlineCidImages(html: string, attachments: readonly ParsedAttachment[]): string {
  const byCid = new Map<string, ParsedAttachment>()
  for (const attachment of attachments) {
    const cid = cidKey(attachment.cid ?? attachment.contentId ?? '')
    if (cid !== undefined && Buffer.isBuffer(attachment.content)) byCid.set(cid, attachment)
  }
  if (byCid.size === 0 || !/cid:/i.test(html)) return html
  // `)` is excluded so a `url(cid:…)` in a style attribute ends in the right
  // place; `:` cannot appear in base64, so an already-inlined image is never
  // rescanned by this.
  return html.replace(/cid:([^"'\s>)]+)/gi, (match, raw: string) => {
    const key = cidKey(raw)
    const found = key === undefined ? undefined : byCid.get(key)
    if (found === undefined || !Buffer.isBuffer(found.content)) return match
    const type = textOf(found.contentType) ?? OCTET_STREAM
    return `data:${type};base64,${found.content.toString('base64')}`
  })
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
 * The readable text of an HTML body, for the mail that ships no `text/plain`.
 *
 * Plenty of what arrives — every marketing blast, and most of what QQ hands
 * over — is a single `text/html` part, and mailparser leaves `text` empty for
 * those. The panel never noticed because it renders the HTML in its sandbox;
 * an agent gets a prompt, and a prompt with no body is a trigger nobody can act
 * on.
 *
 * A regex is the wrong tool for HTML in general and the right one for this: the
 * input is one mail body rather than a page, there is no renderer in this
 * process, and the consumer wants the words in order, not a faithful tree. What
 * it must never do is leak a script or a style block into the prompt, which is
 * what the first two substitutions are for.
 * @param html - the raw HTML part.
 * @returns the text, with a blank line where the page broke one.
 */
export function textOfHtml(html: string): string {
  return html
    // Comments and whole elements that carry no visible text.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // A break where the page broke one, so paragraphs do not run together.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|ul|ol)\s*>/gi, '\n')
    // Everything still bracketed is markup.
    .replace(/<[^>]*>/g, '')
    // The handful of entities a mail actually uses; a numeric reference is
    // decoded only when it names a code point, so a stray one cannot throw.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The message's own text, or one read out of its HTML when it has none.
 * @param parsed - what the parser made of the source.
 * @param html - the HTML part, as the sender wrote it (before any substitution),
 *   when the message carried one.
 * @returns the text to show or to hand over.
 */
function ownTextOf(parsed: ParsedMail | undefined, html: string | undefined): string {
  const own = parsed?.text ?? ''
  if (own.trim() !== '') return own
  return html === undefined ? '' : textOfHtml(html)
}

/** Boundary of the alternative section {@link assembleOwnBody} writes. */
const ALTERNATIVE_BOUNDARY = 'dsh-mail-alternative'

/** Boundary of the related section it writes. */
const RELATED_BOUNDARY = 'dsh-mail-related'

/**
 * The headers one part is handed back with, so the parser reads it as it was.
 *
 * `Content-Type` carries the charset, which is half of what makes the bytes
 * readable; `Content-Transfer-Encoding` is the other half. `Content-ID` is only
 * ever set on a part the HTML names.
 * @param part - the part being written back.
 * @returns the header block, blank line included.
 */
function partHeaders(part: MailPart): string {
  const lines = [`Content-Type: ${part.contentType}`]
  if (part.encoding !== undefined) lines.push(`Content-Transfer-Encoding: ${part.encoding}`)
  if (part.cid !== undefined) lines.push(`Content-ID: ${part.cid}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * One part as it appears inside a multipart body, its opening boundary included.
 *
 * The line break before a closing boundary belongs to the boundary, not to the
 * part (RFC 2046 §5.1.1), so it is added only when the part does not already end
 * with one. Adding it unconditionally would hand the parser a body with a line
 * break the sender never wrote, every time.
 * @param part - the part to write.
 * @param boundary - the boundary it sits between.
 * @returns the chunk.
 */
function partChunk(part: MailPart, boundary: string): Buffer {
  const broken = part.content.length > 0 && part.content[part.content.length - 1] === 0x0a
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n${partHeaders(part)}`),
    part.content,
    Buffer.from(broken ? '' : '\r\n'),
  ])
}

/** A multipart body of one subtype, wrapping the chunks it is given. */
function multipart(subtype: string, boundary: string, chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from(`Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n`),
    ...chunks,
    Buffer.from(`--${boundary}--\r\n`),
  ])
}

/**
 * The parts of a message's own body, written back as one MIME body.
 *
 * The reading pane reads a message by asking the server for its own parts rather
 * than for the message (see `imap.ts`), so the parser has to be handed something
 * that means the same thing as what was skipped. What it is handed is the
 * smallest body that does: the plain text and the related block — HTML plus the
 * pictures it names — side by side inside an `alternative`, which is the tree
 * real mail uses and the one the parser reads `text` and `html` out of.
 *
 * A message that *is* a single part stays a single part — the message was one
 * when it arrived, and it is the shape the parser turns an HTML-only body into
 * text from. A message that carried its body inside a multipart keeps that tree
 * even when only one part of it survived the fetch, for the same reason.
 * @param input - the parts the server answered with; any of them may be absent.
 * @returns the body to parse, or undefined when the message has none.
 */
export function assembleOwnBody(input: OwnParts): Buffer | undefined {
  const text = input.text ?? []
  const html = input.html ?? []
  const inline = input.inline ?? []
  const related = [...html, ...inline]
  const total = text.length + related.length
  if (total === 0) return undefined
  if (total === 1) {
    const only = (text[0] ?? related[0]) as MailPart
    if (only.root === true) return Buffer.concat([Buffer.from(partHeaders(only)), only.content])
  }
  // Two or more parts of the same block go inside a `related` of their own; a
  // lone one sits directly in the alternative rather than in a wrapper around
  // nothing.
  const relatedBlock = related.length <= 1
    ? related.map(part => partChunk(part, ALTERNATIVE_BOUNDARY))
    : [Buffer.concat([
        Buffer.from(`--${ALTERNATIVE_BOUNDARY}\r\n`),
        multipart('related', RELATED_BOUNDARY, related.map(part => partChunk(part, RELATED_BOUNDARY))),
      ])]
  return multipart('alternative', ALTERNATIVE_BOUNDARY, [
    ...text.map(part => partChunk(part, ALTERNATIVE_BOUNDARY)),
    ...relatedBlock,
  ])
}

/**
 * One message's own parts as the reading pane's shape.
 *
 * An attachment is never downloaded to be shown or even to be listed: the parts
 * fetched are the ones the body is made of, and the list comes from the structure
 * the server already described. That is what keeps a three-megabyte message
 * holding a three-megabyte PDF from costing anything to open.
 *
 * Nothing is cut here either. The only bound left is on a single body part, and
 * it belongs to the caller (`MAX_BODY_PART_BYTES` in `imap.ts`), which is why
 * `truncated` is the caller's to decide.
 * @param input - the parts, the headers, and the row the message belongs to.
 * @returns the message with its body and attachment list.
 */
export async function parseDetail(input: {
  summary: MailSummary
  /** To and Cc as the envelope reported them: the assembled body carries no message headers. */
  to: readonly MailAddress[]
  cc: readonly MailAddress[]
  /** The attachment list, read from the structure rather than from a download. */
  attachments: readonly MailAttachment[]
  parts: OwnParts
}): Promise<Omit<MailDetail, 'truncated'>> {
  const own = assembleOwnBody(input.parts)
  const parsed = own === undefined ? undefined : await simpleParser(own) as ParsedMail | undefined
  const raw = typeof parsed?.html === 'string' ? parsed.html : undefined
  const text = ownTextOf(parsed, raw)
  const html = raw === undefined ? undefined : inlineCidImages(raw, parsed?.attachments ?? [])

  return {
    ...input.summary,
    to: input.to,
    cc: input.cc,
    text,
    ...(html === undefined ? {} : { html }),
    attachments: input.attachments,
  }
}
