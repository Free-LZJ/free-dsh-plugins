/**
 * Reading the header block triage is allowed to see.
 *
 * The cases here are the ways this silently stops working: a folded header
 * (GitHub's `List-Id` and `List-Unsubscribe` both fold), a repeated `To`, a
 * message whose headers are not where the parser assumed they were, and bytes
 * rather than text. The fixture is a real-shaped GitHub notification rather
 * than a string built to pass.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTriageHeaders, TRIAGE_HEADERS } from '../src/headers.ts'

const github = readFileSync(new URL('./fixtures/github.eml', import.meta.url))

describe('TRIAGE_HEADERS', () => {
  it('is the whitelist the parser actually applies', () => {
    const parsed = parseTriageHeaders(github)
    for (const name of Object.keys(parsed)) expect(TRIAGE_HEADERS).toContain(name)
    // Nothing outside the whitelist leaks in, however tempting (`Reply-To`,
    // `Received` and `Subject` are all in the fixture).
    expect(parsed['reply-to']).toBeUndefined()
    expect(parsed['received']).toBeUndefined()
    expect(parsed['subject']).toBeUndefined()
  })
})

describe('parseTriageHeaders', () => {
  it('unfolds a folded List-Id, which is how GitHub sends it', () => {
    // The header is split after the group name and continues with a space.
    // Unfolding is removing the break and keeping the whitespace.
    const headers = parseTriageHeaders(github)
    expect(headers['list-id']).toBe('free-lzj/dsh-plugins <dsh-plugins.free-lzj.github.com>')
  })

  it('unfolds a second folded header in the same block', () => {
    const headers = parseTriageHeaders(github)
    expect(headers['list-unsubscribe']).toBe(
      '<https://github.com/notifications/unsubscribe-auth/ABC123>, <mailto:noreply@github.com?subject=unsubscribe>',
    )
  })

  it('reads the plain GitHub routing headers', () => {
    const headers = parseTriageHeaders(github)
    expect(headers['x-github-reason']).toBe('review_requested')
    expect(headers['x-github-sender']).toBe('zejian-li')
    expect(headers['x-github-recipient']).toBe('Free-LZJ')
    expect(headers['precedence']).toBe('list')
    expect(headers['auto-submitted']).toBe('auto-generated')
    expect(headers['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click')
  })

  it('never reads the body, even when a body line looks like a header', () => {
    // The fixture's last line is `List-Id: this line is body text…`, after the
    // blank line. Reading it would let a sender decide a rule's outcome.
    expect(github.toString('latin1')).toContain('this line is body text')
    expect(parseTriageHeaders(github)['list-id']).not.toContain('body text')
  })

  it('joins a header that appears more than once, as To and Cc do', () => {
    const source = [
      'To: first@example.com',
      'Cc: one@example.com',
      'to: second@example.com',
      '',
      'body',
    ].join('\r\n')
    const headers = parseTriageHeaders(source)
    expect(headers['to']).toBe('first@example.com, second@example.com')
    expect(headers['cc']).toBe('one@example.com')
  })

  it('reads a message that only uses \\n, which is what some servers hand over', () => {
    const headers = parseTriageHeaders('List-Id: a/b\n <b.a.example>\nX-QQ-Csender: me@qq.com\n\nbody\n')
    expect(headers['list-id']).toBe('a/b <b.a.example>')
    expect(headers['x-qq-csender']).toBe('me@qq.com')
  })

  it('accepts bytes and decodes them as latin1', () => {
    // 0xE9 is `é` in latin1 and a lone continuation byte in utf8 — decoding it
    // as utf8 would turn the value into a replacement character.
    const bytes = Buffer.from('X-QQ-Csender: caf\u00e9@qq.com\n\n', 'latin1')
    expect(parseTriageHeaders(bytes)['x-qq-csender']).toBe('café@qq.com')
    expect(parseTriageHeaders(bytes)).toEqual(parseTriageHeaders(bytes.toString('latin1')))
  })

  it('answers nothing for a message with no header section', () => {
    expect(parseTriageHeaders(undefined)).toEqual({})
    expect(parseTriageHeaders('')).toEqual({})
    expect(parseTriageHeaders('\r\n\r\njust a body')).toEqual({})
    expect(parseTriageHeaders('not a header line at all')).toEqual({})
  })

  it('treats a header present but empty as absent, not as an empty string', () => {
    // `List-Unsubscribe:` with nothing after it is not a way to unsubscribe, and
    // a rule that tests for the header's existence must not read it as one.
    const headers = parseTriageHeaders('List-Unsubscribe:   \r\nPrecedence: list\r\n\r\n')
    expect('list-unsubscribe' in headers).toBe(false)
    expect(headers['precedence']).toBe('list')
  })

  it('keeps a header-only message readable, with no blank line to stop at', () => {
    expect(parseTriageHeaders('Precedence: bulk')).toEqual({ precedence: 'bulk' })
  })

  it('survives a malformed block instead of throwing', () => {
    const headers = parseTriageHeaders(': no name\r\nPrecedence\r\nTo: a@b.c\r\n')
    expect(headers).toEqual({ to: 'a@b.c' })
  })
})
