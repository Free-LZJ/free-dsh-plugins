import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DEFAULT_FALLBACK_SCAN_SECONDS,
  DEFAULT_IMAP_TIMEOUT_SECONDS,
  DEFAULT_MAX_LIST_MESSAGES,
  MAX_TRUSTED_SENDERS,
  normalizeAccountInput,
  normalizeAction,
  normalizeDraft,
  normalizePreferences,
  senderKey,
  trustedSendersOf,
  withTrustedSender,
} from '../src/config.ts'

describe('DEFAULT_CONFIG', () => {
  it('is the three constants plus the triage group, and the values the loader row documents', () => {
    expect(DEFAULT_CONFIG).toEqual({
      fallbackScanSeconds: DEFAULT_FALLBACK_SCAN_SECONDS,
      maxListMessages: DEFAULT_MAX_LIST_MESSAGES,
      imapTimeoutSeconds: DEFAULT_IMAP_TIMEOUT_SECONDS,
      // 分诊的默认值在 `src/triage/config.ts` 里；这里只钉住接线的形状。
      triage: {
        enabled: true,
        dryRun: false,
        undoWindowSeconds: 120,
        runHistoryLimit: 500,
        runRetentionDays: 30,
        repoRoot: 'D:/open',
      },
    })
    expect([DEFAULT_FALLBACK_SCAN_SECONDS, DEFAULT_MAX_LIST_MESSAGES, DEFAULT_IMAP_TIMEOUT_SECONDS]).toEqual([300, 300, 30])
  })
})

describe('image preferences', () => {
  it('normalizes an address the way the whitelist stores it', () => {
    expect(senderKey('  Alice@Example.COM ')).toBe('alice@example.com')
    expect(senderKey('张三 <zhang@qq.com>')).toBeUndefined()
    expect(senderKey('a@b.com, c@d.com')).toBeUndefined()
    expect(senderKey('')).toBeUndefined()
    expect(senderKey(42)).toBeUndefined()
  })

  it('keeps a stored list to usable addresses, deduplicated and capped', () => {
    expect(trustedSendersOf(['a@b.com', 'A@B.com', 'nope', '', 7])).toEqual(['a@b.com'])
    expect(trustedSendersOf('not a list')).toEqual([])
    const many = Array.from({ length: MAX_TRUSTED_SENDERS + 20 }, (_, index) => `user${String(index)}@example.com`)
    expect(trustedSendersOf(many)).toHaveLength(MAX_TRUSTED_SENDERS)
  })

  it('adds newest-first and removes without disturbing the rest', () => {
    expect(withTrustedSender(['old@x.com'], 'new@x.com', true)).toEqual(['new@x.com', 'old@x.com'])
    // Re-adding an address moves it to the front rather than duplicating it.
    expect(withTrustedSender(['a@x.com', 'b@x.com'], 'b@x.com', true)).toEqual(['b@x.com', 'a@x.com'])
    expect(withTrustedSender(['a@x.com', 'b@x.com'], 'a@x.com', false)).toEqual(['b@x.com'])
    // The cap drops the tail, not the entry just made.
    const full = Array.from({ length: MAX_TRUSTED_SENDERS }, (_, index) => `user${String(index)}@example.com`)
    const next = withTrustedSender(full, 'new@example.com', true)
    expect(next).toHaveLength(MAX_TRUSTED_SENDERS)
    expect(next[0]).toBe('new@example.com')
    // The tail is what falls off: newest-first, so the least recently added goes.
    expect(next).not.toContain(`user${String(MAX_TRUSTED_SENDERS - 1)}@example.com`)
  })

  it('rejects a preference payload that is not a flag', () => {
    expect(normalizePreferences({ loadRemoteImages: false })).toEqual({ ok: true, value: { loadRemoteImages: false } })
    expect(normalizePreferences({ loadRemoteImages: 'off' })).toMatchObject({ ok: false, field: 'loadRemoteImages' })
    expect(normalizePreferences(undefined)).toMatchObject({ ok: false, field: 'preferences' })
  })
})


describe('normalizeAccountInput', () => {
  const form = { address: ' A@x.com ', imapHost: ' imap.qq.com ', imapPort: 993, secure: true, provider: 'qq' }

  it('fills in what a minimal form leaves out', () => {
    expect(normalizeAccountInput(form)).toEqual({
      ok: true,
      value: {
        name: 'A@x.com',
        address: 'A@x.com',
        provider: 'qq',
        imapHost: 'imap.qq.com',
        imapPort: 993,
        secure: true,
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
