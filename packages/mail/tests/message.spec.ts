/**
 * What one message has to look like by the time the panel sees it: a preview cut
 * on a word boundary, one address shape from three different sources, and a
 * reading pane whose body and attachment list survive a real multipart message.
 *
 * The fixtures are real `.eml` files rather than strings, so the parser runs
 * against the same bytes a server hands over.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MailSummary } from '../src/types.ts'
import {
  addressOf, addressesOf, isFlagged, isUnseen, parseDetail, snippetOf, toSummary,
} from '../src/message.ts'

const multipart = readFileSync(new URL('./fixtures/multipart.eml', import.meta.url))
const plain = readFileSync(new URL('./fixtures/plain.eml', import.meta.url))

/** The row a detail call is built on; the body is what the test is about. */
function summaryOf(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 'acct',
    folder: 'INBOX',
    uid: 7,
    uidValidity: 3,
    subject: 'Quarterly report',
    from: { name: 'Alice Example', address: 'alice@example.com' },
    date: '2026-01-01T02:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: '',
    ...overrides,
  }
}

describe('the fixture', () => {
  it('is the multipart message these tests assume', () => {
    const text = multipart.toString('utf8')
    expect(text).toContain('boundary="outer-boundary"')
    expect(text).toContain('filename="report.pdf"')
  })
})

describe('snippetOf', () => {
  it('collapses whitespace and trims', () => {
    expect(snippetOf('  hello\n\n   world  ')).toBe('hello world')
  })

  it('cuts on a word boundary', () => {
    // "alpha beta g" is 12 characters; the last boundary before it is at 10.
    expect(snippetOf('alpha beta gamma delta', 12)).toBe('alpha beta…')
  })

  it('cuts mid-word when there is no boundary near the cap', () => {
    expect(snippetOf('y'.repeat(300), 10)).toBe(`${'y'.repeat(10)}…`)
  })

  it('leaves a short text alone and caps the default at 200 characters plus the ellipsis', () => {
    expect(snippetOf('short')).toBe('short')
    expect(snippetOf('x'.repeat(300))).toHaveLength(201)
  })
})

describe('addressOf', () => {
  it('reads a name and an address', () => {
    expect(addressOf({ name: 'Alice', address: 'alice@example.com' }))
      .toEqual({ name: 'Alice', address: 'alice@example.com' })
  })

  it('reads a bare string', () => {
    expect(addressOf('alice@example.com')).toEqual({ address: 'alice@example.com' })
  })

  it('omits an absent name and survives a missing address', () => {
    expect(addressOf({ name: '   ', address: 'alice@example.com' })).toEqual({ address: 'alice@example.com' })
    expect(addressOf(undefined)).toEqual({ address: '' })
  })
})

describe('addressesOf', () => {
  it('reads the three containers the sources use', () => {
    expect(addressesOf([{ address: 'a@example.com' }, { name: 'B', address: 'b@example.com' }])).toHaveLength(2)
    expect(addressesOf({ value: [{ address: 'c@example.com' }] })).toEqual([{ address: 'c@example.com' }])
    expect(addressesOf('d@example.com')).toEqual([{ address: 'd@example.com' }])
  })

  it('drops entries with no address at all', () => {
    expect(addressesOf(undefined)).toEqual([])
    expect(addressesOf([{ name: 'nobody' }, { address: 'e@example.com' }])).toEqual([{ address: 'e@example.com' }])
  })
})

describe('flags', () => {
  it('reads \\Seen as "read" and \\Flagged as "starred"', () => {
    expect(isUnseen(new Set())).toBe(true)
    expect(isUnseen(new Set(['\\Seen']))).toBe(false)
    expect(isFlagged(new Set(['\\Flagged']))).toBe(true)
    expect(isFlagged(new Set(['\\Seen']))).toBe(false)
  })
})

describe('toSummary', () => {
  it('normalizes one FETCH result without touching the body', () => {
    const summary = toSummary({
      accountId: 'acct',
      folder: 'INBOX',
      uid: 42,
      uidValidity: 9,
      flags: new Set(['\\Seen', '\\Flagged']),
      envelope: { subject: 'Hi', from: [{ name: 'Alice', address: 'alice@example.com' }], date: new Date('2026-02-03T04:05:06Z') },
      internalDate: new Date('2026-02-03T04:05:06Z'),
      size: 1234,
      hasAttachments: true,
      preview: 'the  body\n\nflattened',
    })
    expect(summary).toMatchObject({
      accountId: 'acct',
      uid: 42,
      uidValidity: 9,
      subject: 'Hi',
      from: { name: 'Alice', address: 'alice@example.com' },
      date: '2026-02-03T04:05:06.000Z',
      seen: true,
      flagged: true,
      hasAttachments: true,
      snippet: 'the body flattened',
    })
  })

  it('falls back on a missing subject, sender and date', () => {
    const summary = toSummary({
      accountId: 'acct',
      folder: 'INBOX',
      uid: 1,
      uidValidity: 1,
      flags: new Set(),
      envelope: {},
      internalDate: 'not a date',
      size: undefined,
      hasAttachments: false,
      preview: '',
    })
    expect(summary.subject).toBe('(无主题)')
    expect(summary.from).toEqual({ address: '' })
    expect(summary.seen).toBe(false)
    expect(Number.isNaN(Date.parse(summary.date))).toBe(false)
  })
})

describe('parseDetail', () => {
  it('gives the text, the HTML and the attachment list', async () => {
    const detail = await parseDetail({ source: multipart, summary: summaryOf() })
    expect(detail.subject).toBe('Quarterly report')
    expect(detail.from).toEqual({ name: 'Alice Example', address: 'alice@example.com' })
    expect(detail.to).toEqual([{ name: 'Bob Receiver', address: 'bob@example.com' }])
    expect(detail.cc).toEqual([{ address: 'carol@example.com' }])
    expect(detail.text).toContain('plain text body')
    expect(detail.html).toContain('<b>world</b>')
    expect(detail.truncated).toBe(false)
    expect(detail.attachments).toHaveLength(1)
    expect(detail.attachments[0]).toMatchObject({ filename: 'report.pdf', contentType: 'application/pdf' })
    expect(detail.attachments[0]?.size).toBeGreaterThan(0)
    // The part has to be an IMAP section — a content id or an index would make
    // the download route fetch the wrong part (or nothing at all).
    expect(detail.attachments[0]?.part).toMatch(/^[1-9]\d*(\.\d+)*$/)
  })

  it('falls back on an empty subject and a missing sender', async () => {
    const detail = await parseDetail({ source: plain, summary: summaryOf({ subject: '(无主题)', from: { address: '' } }) })
    expect(detail.subject).toBe('(无主题)')
    // The fixture carries no From header, so the summary's stand-in survives.
    expect(detail.from).toEqual({ address: '' })
    expect(detail.attachments).toEqual([])
  })

  it('cuts a body to the default cap and says so', async () => {
    const limit = 256 * 1024
    const source = `Subject: big\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${'word '.repeat(60_000)}`
    const detail = await parseDetail({ source, summary: summaryOf() })
    expect(detail.truncated).toBe(true)
    expect(Buffer.byteLength(detail.text, 'utf8')).toBeLessThanOrEqual(limit)
    expect(detail.text.length).toBeGreaterThan(limit - 16)
  })

  it('cuts to a caller cap without leaving half a character behind', async () => {
    const source = `Subject: cjk\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${'中'.repeat(2000)}`
    const detail = await parseDetail({ source, summary: summaryOf(), maxTextBytes: 1000 })
    expect(detail.truncated).toBe(true)
    // 1000 bytes hold 333 whole three-byte characters; the 334th is halved.
    expect(detail.text).toHaveLength(333)
    expect(detail.text).not.toContain('\uFFFD')
  })

  it('keeps the summary it was handed and prefers the parsed headers', async () => {
    const summary = summaryOf({ folder: 'Archive', uid: 99, uidValidity: 5 })
    const detail = await parseDetail({ source: plain, summary })
    expect(detail.folder).toBe('Archive')
    expect(detail.uid).toBe(99)
    expect(detail.uidValidity).toBe(5)
    expect(detail.to).toEqual([{ address: 'someone@example.com' }])
  })
})
