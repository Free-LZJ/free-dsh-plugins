/**
 * The slice of a message's header block that triage rules are allowed to see.
 *
 * A scan already fetches the head of every message (`SUMMARY_QUERY`), so the
 * raw headers are in hand; what was missing is reading them. They are read here
 * and nowhere else, as a pure function over bytes, so the parsing rules — the
 * folding, the whitelist, the first blank line — are testable without a socket.
 *
 * Three things this must get right, because they are all how a rule silently
 * stops matching:
 *
 * - **Folding.** A long header is split across lines whose continuations start
 *   with whitespace (RFC 5322 §2.2.3), and GitHub's `List-Id` is long enough to
 *   fold. Unfolding is removing the line break and keeping the whitespace.
 * - **The header section only.** Everything after the first blank line is body,
 *   which can be megabytes; a body line that happens to look like `List-Id: …`
 *   is not a header.
 * - **Repeats.** `To` and `Cc` may each appear several times and mean one list
 *   (RFC 5322 §3.6.3), so repeats are joined rather than the last one winning.
 *
 * @module @free-lzj/dsh-mail/headers
 */

import type { MailHeaders } from './types.ts'

/**
 * The headers triage is allowed to use, and the whole of what it may see.
 *
 * A whitelist rather than "everything minus the obvious": every header here is
 * one a rule plausibly decides something on — list membership, a bounce
 * convention, GitHub's own routing fields — and the cost of the list is only
 * that a new rule about a new header has to add one name.
 */
export const TRIAGE_HEADERS = [
  'list-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'precedence',
  'x-github-reason',
  'x-github-sender',
  'x-github-recipient',
  'x-github-severity',
  'x-qq-csender',
  'auto-submitted',
  'feedback-id',
  'to',
  'cc',
] as const

/** The whitelist as a lookup, built once so a scan does not rebuild it per message. */
const WHITELISTED: ReadonlySet<string> = new Set(TRIAGE_HEADERS)

/**
 * Where the header section ends, or -1 when the message is all headers.
 *
 * Both line endings are looked for because a server may hand over either: the
 * two searches cannot collide, since `\r\n\r\n` contains no `\n\n`.
 * @param text - the whole fetched head, decoded.
 * @returns the index of the first blank line, or -1.
 */
function headerEnd(text: string): number {
  const crlf = text.indexOf('\r\n\r\n')
  const lf = text.indexOf('\n\n')
  if (crlf === -1) return lf
  if (lf === -1) return crlf
  return Math.min(crlf, lf)
}

/**
 * The whitelisted headers of one message, unfolded and lowercased.
 *
 * A header that is absent is absent from the result rather than an empty
 * string, and so is one that is present but empty: `List-Unsubscribe:` with
 * nothing after it means "no way to unsubscribe", and a rule that tests for the
 * header's existence must not read it as one. Values are trimmed; everything
 * else is left as the sender wrote it.
 * @param source - the fetched message head, as bytes or as text.
 * @returns the headers triage may read, keyed by lowercased name.
 */
export function parseTriageHeaders(source: string | Buffer | undefined): MailHeaders {
  if (source === undefined) return {}
  // Headers are ASCII (RFC 5322 §2.2), and latin1 is the decoding that cannot
  // fail: utf8 turns an un-encoded byte into U+FFFD and would also misjudge
  // nothing here, but it can throw nothing and lose nothing, either — while
  // latin1 round-trips every byte a sender actually wrote.
  const text = Buffer.isBuffer(source) ? source.toString('latin1') : source
  const end = headerEnd(text)
  const section = end === -1 ? text : text.slice(0, end)

  // Unfold while walking the lines: a line starting with whitespace continues
  // the one before it, and the break between them is simply dropped.
  const lines: string[] = []
  for (const line of section.split(/\r?\n/)) {
    if (line.length === 0) continue
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line
      continue
    }
    lines.push(line)
  }

  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    // No colon at all means this is not a header field (a `From ` envelope line,
    // say), and a colon at position zero would be a name nobody could read.
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!WHITELISTED.has(name)) continue
    const value = line.slice(colon + 1).trim()
    if (value === '') continue
    const seen = headers[name]
    headers[name] = seen === undefined ? value : `${seen}, ${value}`
  }
  return headers
}
