import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DEFAULT_FALLBACK_SCAN_SECONDS,
  DEFAULT_IMAP_TIMEOUT_SECONDS,
  DEFAULT_MAX_LIST_MESSAGES,
  normalizeAccountInput,
  normalizeAction,
  normalizeDraft,
  normalizeTrigger,
} from '../src/config.ts'

/** The trigger a request that says nothing usable ends up with. */
const PANEL = { mode: 'panel', filters: {} }

describe('DEFAULT_CONFIG', () => {
  it('is the three constants, and the values the loader row documents', () => {
    expect(DEFAULT_CONFIG).toEqual({
      fallbackScanSeconds: DEFAULT_FALLBACK_SCAN_SECONDS,
      maxListMessages: DEFAULT_MAX_LIST_MESSAGES,
      imapTimeoutSeconds: DEFAULT_IMAP_TIMEOUT_SECONDS,
    })
    expect([DEFAULT_FALLBACK_SCAN_SECONDS, DEFAULT_MAX_LIST_MESSAGES, DEFAULT_IMAP_TIMEOUT_SECONDS]).toEqual([300, 300, 30])
  })
})

describe('normalizeTrigger', () => {
  it('falls back to panel for anything it cannot read', () => {
    for (const input of [undefined, null, 42, 'panel', [], { mode: 'bogus' }, { mode: 'SESSION' }, { mode: 'panel' }]) {
      expect(normalizeTrigger(input)).toEqual(PANEL)
    }
  })

  it('refuses a session trigger whose workspace is not an absolute path', () => {
    for (const input of [
      { mode: 'session' },
      { mode: 'session', session: {} },
      { mode: 'session', session: { workspacePath: '' } },
      { mode: 'session', session: { workspacePath: 'relative/path' } },
      { mode: 'session', session: { workspacePath: 42 } },
      { mode: 'session', workspacePath: '/ws' },
    ]) {
      expect(normalizeTrigger(input)).toEqual(PANEL)
    }
  })

  it('keeps a session trigger whose workspace is absolute, and only the options that carry something', () => {
    expect(normalizeTrigger({
      mode: 'session',
      session: { workspacePath: ' /ws/workspace ', agentPreset: ' fast ', permissionPreset: '  ', titleTemplate: 7 },
      filters: { unreadOnly: false },
    })).toEqual({
      mode: 'session',
      session: { workspacePath: '/ws/workspace', agentPreset: 'fast' },
      filters: { unreadOnly: false },
    })
  })

  it('refuses a notify trigger without a session id', () => {
    for (const input of [
      { mode: 'notify' },
      { mode: 'notify', notify: {} },
      { mode: 'notify', notify: { sessionId: '   ' } },
      { mode: 'notify', notify: { sessionId: 7 } },
    ]) {
      expect(normalizeTrigger(input)).toEqual(PANEL)
    }
    expect(normalizeTrigger({ mode: 'notify', notify: { sessionId: 's-1' } }))
      .toEqual({ mode: 'notify', notify: { sessionId: 's-1' }, filters: {} })
  })

  it('cleans each filter group and believes unreadOnly only when it is a boolean', () => {
    expect(normalizeTrigger({
      filters: { from: [' a@x.com ', '', 7, null, 'b@x.com'], subject: 'not an array', keywords: ['  '] },
    })).toEqual({ mode: 'panel', filters: { from: ['a@x.com', 'b@x.com'] } })
    expect(normalizeTrigger({ filters: { unreadOnly: 'yes' } })).toEqual(PANEL)
    expect(normalizeTrigger({ filters: { unreadOnly: true } })).toEqual({ mode: 'panel', filters: { unreadOnly: true } })
  })

  it('forgets the options of the modes it is not in', () => {
    expect(normalizeTrigger({ mode: 'panel', session: { workspacePath: '/ws' }, notify: { sessionId: 's' } })).toEqual(PANEL)
  })
})

describe('normalizeAccountInput', () => {
  const form = { address: ' A@x.com ', imapHost: ' imap.qq.com ', imapPort: 993, secure: true, provider: 'qq' }

  it('fills in what a minimal form leaves out', () => {
    expect(normalizeAccountInput({ ...form, trigger: { mode: 'bogus' } })).toEqual({
      ok: true,
      value: {
        name: 'A@x.com',
        address: 'A@x.com',
        provider: 'qq',
        imapHost: 'imap.qq.com',
        imapPort: 993,
        secure: true,
        trigger: PANEL,
      },
    })
  })

  it('accepts the port a number input sends as text, and the secure default', () => {
    const result = normalizeAccountInput({ ...form, imapPort: '995', secure: undefined })
    expect(result.ok && result.value.imapPort).toBe(995)
    expect(result.ok && result.value.secure).toBe(true)
  })

  it('keeps a well-formed id and names the field that made it unusable', () => {
    const kept = normalizeAccountInput({ ...form, id: 'm0123456789abcde' })
    expect(kept.ok && kept.value.id).toBe('m0123456789abcde')
    const cases: readonly (readonly [unknown, string])[] = [
      [null, 'account'],
      [{ ...form, id: 'M0123' }, 'id'],
      [{ ...form, id: 7 }, 'id'],
      [{ ...form, address: '' }, 'address'],
      [{ ...form, address: 'no-at-sign' }, 'address'],
      [{ ...form, imapHost: '   ' }, 'imapHost'],
      [{ ...form, imapPort: 0 }, 'imapPort'],
      [{ ...form, imapPort: 65536 }, 'imapPort'],
      [{ ...form, imapPort: 993.5 }, 'imapPort'],
      [{ ...form, imapPort: 'x' }, 'imapPort'],
      [{ ...form, imapPort: undefined }, 'imapPort'],
      [{ ...form, secure: 'yes' }, 'secure'],
      [{ ...form, provider: 'outlook' }, 'provider'],
      [{ ...form, provider: undefined }, 'provider'],
    ]
    for (const [input, field] of cases) {
      const result = normalizeAccountInput(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.field).toBe(field)
    }
  })
})

describe('normalizeDraft', () => {
  const draft = { address: 'a@x.com', imapHost: 'imap.qq.com', imapPort: 993, secure: true, password: 'code' }

  it('reads back a draft that could connect', () => {
    expect(normalizeDraft(draft)).toEqual({ ok: true, value: draft })
  })

  it('names the field that would have made the probe misleading', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [null, 'draft'],
      [{ ...draft, address: 'nope' }, 'address'],
      [{ ...draft, imapHost: '' }, 'imapHost'],
      [{ ...draft, imapPort: 70000 }, 'imapPort'],
      [{ ...draft, secure: 1 }, 'secure'],
      [{ ...draft, password: '' }, 'password'],
      [{ ...draft, password: '  ' }, 'password'],
      [{ ...draft, password: undefined }, 'password'],
    ]
    for (const [input, field] of cases) {
      const result = normalizeDraft(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.field).toBe(field)
    }
  })
})

describe('normalizeAction', () => {
  const action = { op: 'markRead', accountId: 'ma', folder: 'INBOX', uids: [1, 2, 3] }

  it('passes an action the Host half can carry out', () => {
    expect(normalizeAction(action)).toEqual({ ok: true, value: action })
    expect(normalizeAction({ ...action, op: 'move', targetFolder: 'Archive' }))
      .toEqual({ ok: true, value: { ...action, op: 'move', targetFolder: 'Archive' } })
  })

  it('refuses every uid list that could touch the wrong messages', () => {
    const rejected = [
      { ...action, uids: [] },
      { ...action, uids: 'INBOX' },
      { ...action, uids: undefined },
      { ...action, uids: [0] },
      { ...action, uids: [-1] },
      { ...action, uids: [1.5] },
      { ...action, uids: ['1'] },
      { ...action, uids: [1, null] },
      { ...action, uids: Array.from({ length: 501 }, (_, index) => index + 1) },
    ]
    for (const input of rejected) {
      const result = normalizeAction(input)
      expect(result).toMatchObject({ ok: false, code: 'invalid_action' })
    }
    expect(normalizeAction({ ...action, uids: Array.from({ length: 500 }, (_, index) => index + 1) }).ok).toBe(true)
  })

  it('refuses a move with nowhere to move to', () => {
    for (const target of [undefined, '', '   ', 7]) {
      expect(normalizeAction({ ...action, op: 'move', targetFolder: target }))
        .toMatchObject({ ok: false, code: 'invalid_action' })
    }
    expect(normalizeAction({ ...action, op: 'move' })).toMatchObject({ ok: false, code: 'invalid_action' })
  })

  it('refuses an operation or a mailbox it does not implement', () => {
    for (const input of [null, [], 'markRead', { ...action, op: 'expunge' }, { ...action, accountId: '' }, { ...action, folder: '  ' }]) {
      expect(normalizeAction(input)).toMatchObject({ ok: false, code: 'invalid_action' })
    }
  })
})
