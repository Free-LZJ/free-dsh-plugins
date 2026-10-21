/**
 * What one message has to look like by the time the panel sees it: a preview cut
 * on a word boundary, one address shape from three different sources, and a
 * reading pane assembled out of the parts the server was asked for.
 *
 * The reading-pane tests hand over parts the way a FETCH does — bytes still in
 * their transfer encoding, `Content-Type` and all — because that is the contract
 * now: what the server answers with, not what a whole `.eml` looks like. Reading
 * the structure that names those parts is `imap.spec.ts`'s half.
 */

import { describe, expect, it } from 'vitest'
import type { MailSummary } from '../src/types.ts'
import {
  addressOf, addressesOf, isFlagged, isUnseen, parseDetail, snippetOf, textOfHtml, toSummary,
  type MailPart,
} from '../src/message.ts'

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
    headers: {},
    ...overrides,
  }
}

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
      source: 'List-Id: owner/repo\r\n <repo.owner.github.com>\r\n\r\nbody\r\n',
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
    // The header section the scan already fetched reaches the row unfolded; see
    // `headers.spec.ts` for the parsing rules themselves.
    expect(summary.headers['list-id']).toBe('owner/repo <repo.owner.github.com>')
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
      source: undefined,
    })
    expect(summary.subject).toBe('(无主题)')
    expect(summary.from).toEqual({ address: '' })
    expect(summary.seen).toBe(false)
    expect(Number.isNaN(Date.parse(summary.date))).toBe(false)
  })
})

describe('textOfHtml', () => {
  it('drops whole blocks that carry no visible text', () => {
    const text = textOfHtml('<head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hello</p></body>')
    expect(text).toBe('Hello')
  })

  it('breaks a line where the page broke one, and decodes entities', () => {
    const text = textOfHtml('<div>first&nbsp;line</div><div>second &amp; third &lt;ok&gt;</div>')
    expect(text).toBe('first line\nsecond & third <ok>')
  })

  it('drops a numeric reference that names no code point instead of throwing', () => {
    expect(textOfHtml('<p>a&#99999999;b</p>')).toBe('ab')
  })
})

describe('parseDetail', () => {
  /** A part as the server hands one over: bytes still in their transfer encoding. */
  const part = (contentType: string, body: string, extra: Partial<MailPart> = {}): MailPart =>
    ({ contentType, content: Buffer.from(body), ...extra })

  it('reads the text and the HTML out of the parts it was handed', async () => {
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [{ name: 'Bob Receiver', address: 'bob@example.com' }],
      cc: [{ address: 'carol@example.com' }],
      attachments: [{ part: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 2048 }],
      parts: {
        text: [part('text/plain; charset=utf-8', 'Hello   world,\nthis is the plain text body of the quarterly report.')],
        html: [part('text/html; charset=utf-8', '<html><body><p>Hello <b>world</b></p></body></html>')],
      },
    })
    expect(detail.text).toContain('plain text body')
    expect(detail.html).toContain('<b>world</b>')
    expect(detail.to).toEqual([{ name: 'Bob Receiver', address: 'bob@example.com' }])
    expect(detail.cc).toEqual([{ address: 'carol@example.com' }])
    // The list is the caller's, read from the structure: nothing here parses a
    // message, and `part` is an IMAP section so the download route can use it.
    expect(detail.attachments).toEqual([
      { part: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 2048 },
    ])
  })

  it('decodes a transfer encoding and a charset it never looked at', async () => {
    // The reason the parts are written back into a MIME body rather than decoded
    // here: base64, quoted-printable and the charset table are the parser's job.
    // A UTF-8 body would prove nothing, so both halves are encoded.
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: {
        text: [part('text/plain; charset=utf-8', 'caf=C3=A9', { encoding: 'quoted-printable' })],
        html: [part('text/html; charset=utf-8', Buffer.from('<p>中文正文</p>', 'utf8').toString('base64'), { encoding: 'base64' })],
      },
    })
    expect(detail.text).toContain('café')
    expect(detail.html).toContain('中文正文')
  })

  it('reads the words out of an HTML-only body', async () => {
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: { html: [part('text/html; charset=utf-8', '<html><body><style>p{color:red}</style><p>尊敬的用户：</p></body></html>')] },
    })
    expect(detail.text).toContain('尊敬的用户')
    expect(detail.text).not.toContain('color:red')
    expect(detail.html).toContain('尊敬的用户')
  })

  it('inlines a cid: image as a data: URI, which is the only form the pane can show', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: {
        html: [part('text/html; charset=utf-8', '<p>看图</p><img src="cid:logo@Example.com">')],
        inline: [part('image/png', png.toString('base64'), { encoding: 'base64', cid: '<logo@example.com>' })],
      },
    })
    // Case differs between the header and the reference, which is normal.
    expect(detail.html).toContain(`data:image/png;base64,${png.toString('base64')}`)
    expect(detail.html).not.toContain('cid:')
    // The plain-text fallback is read from the markup before the substitution,
    // so a base64 payload can never leak into what a prompt receives.
    expect(detail.text).not.toContain('base64')
    expect(detail.text).toContain('看图')
  })

  it('leaves a cid: it cannot resolve as written, for the pane to block', async () => {
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: { html: [part('text/html; charset=utf-8', '<img src="cid:missing@example.com">')] },
    })
    expect(detail.html).toContain('cid:missing@example.com')
  })

  it('shows nothing for a message that carries no body at all', async () => {
    // An attachment-only mail: the pane has a file to offer and no words, which
    // is what the message is. Nothing is fetched to find that out.
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [{ part: '1', filename: 'archive.zip', contentType: 'application/zip', size: 99 }],
      parts: {},
    })
    expect(detail.text).toBe('')
    expect(detail.html).toBeUndefined()
    expect(detail.attachments).toHaveLength(1)
  })

  it('hands a long body over whole instead of cutting it', async () => {
    // 300 KB, past the 256 KB this module used to cut at — which is what arrived
    // as "正文过长", and, for an HTML body, as a message with no pictures: the cut
    // lands inside the markup and the browser drops whatever followed it.
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: { text: [part('text/plain; charset=utf-8', 'word '.repeat(60_000))] },
    })
    expect(Buffer.byteLength(detail.text, 'utf8')).toBeGreaterThan(256 * 1024)
    expect(detail.text.trimEnd().endsWith('word')).toBe(true)
  })

  it('joins several parts of one kind, the way the parser does', async () => {
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: {
        text: [part('text/plain; charset=utf-8', 'first'), part('text/plain; charset=utf-8', 'second')],
      },
    })
    expect(detail.text).toContain('first')
    expect(detail.text).toContain('second')
  })

  it('keeps a message that is one part as one part', async () => {
    // The parser reads an HTML-only body itself when that body is the whole
    // message, and leaves it to `textOfHtml` when it is one part of a multipart.
    // Two different texts — which is why the assembled body has to remember
    // which one the sender sent.
    const html = '<html><body><p>first</p><p>second</p></body></html>'
    const whole = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: { html: [part('text/html; charset=utf-8', html, { root: true })] },
    })
    const oneOfSeveral = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: { html: [part('text/html; charset=utf-8', html)] },
    })
    expect(whole.text).toBe('first\n\nsecond')
    expect(oneOfSeveral.text).toBe('first\nsecond')
  })

  it('does not add a line break the sender never wrote', async () => {
    // The CRLF before a boundary belongs to the boundary (RFC 2046 §5.1.1). A
    // part fetched on its own already ends with the one that framed it, so the
    // assembled body must not add a second — the parser would then hand back a
    // body one line break longer than the sender's.
    const detail = await parseDetail({
      summary: summaryOf(),
      to: [],
      cc: [],
      attachments: [],
      parts: {
        html: [part('text/html; charset=utf-8', '<p>正文</p>\r\n')],
        inline: [part('image/png', Buffer.from('89504e47', 'hex').toString('base64'), { encoding: 'base64', cid: '<a@b>' })],
      },
    })
    expect(detail.html).toBe('<p>正文</p>')
  })

  it('keeps the row it was handed', async () => {
    const summary = summaryOf({ folder: 'Archive', uid: 99, uidValidity: 5 })
    const detail = await parseDetail({
      summary,
      to: [],
      cc: [],
      attachments: [],
      parts: { text: [part('text/plain; charset=utf-8', 'hi')] },
    })
    expect(detail.folder).toBe('Archive')
    expect(detail.uid).toBe(99)
    expect(detail.uidValidity).toBe(5)
  })
})
