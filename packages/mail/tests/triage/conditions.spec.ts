/**
 * 条件的语义与边界。
 *
 * 重点是**边界**而不是快乐路径：头部缺失与头部为空串是两回事、`regex` 编译失败要在
 * 加载期就被拦住、`classifier` 拿不准时必须判不命中。这些正是「邮件被错误地自动处理
 * 掉」会经过的地方。
 *
 * @module @free-lzj/dsh-mail/tests/triage/conditions
 */

import { describe, expect, it } from 'vitest'
import { builtinConditions, headerCondition, regexCondition, fromCondition, classifierCondition, attachmentCondition } from '../../src/triage/conditions.ts'
import { normalizeCondition } from '../../src/triage/config.ts'
import { parseRules } from '../../src/triage/rules.ts'
import type { MailSummaryLike } from '../../src/triage/types.ts'

/** 造一封摘要；头部按传入的来。 */
function mail(overrides: Partial<MailSummaryLike> = {}): MailSummaryLike {
  return {
    accountId: 'acc',
    folder: 'INBOX',
    uid: 7,
    uidValidity: 3,
    subject: 'Run failed: E2E',
    from: { address: 'notifications@github.com', name: 'lzj' },
    date: '2026-10-21T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: 'workflow failed',
    headers: {},
    ...overrides,
  }
}

describe('发货的条件实现', () => {
  it('八种条件都注册了，且 kind 与实现一一对应', () => {
    const kinds = builtinConditions().map(condition => condition.kind).sort()
    expect(kinds).toEqual(['attachment', 'body', 'classifier', 'from', 'header', 'regex', 'subject', 'to'])
  })

  it('只有 body 与 classifier 声明需要正文', () => {
    const needing = builtinConditions().filter(condition => condition.needsBody).map(condition => condition.kind).sort()
    expect(needing).toEqual(['body', 'classifier'])
  })

  it('regex 只在作用到正文上时才声明需要正文', () => {
    expect(regexCondition.needsBody).toBe(false)
    expect(regexCondition.needsBodyFor?.({ kind: 'regex', field: 'body', pattern: '.' })).toBe(true)
    expect(regexCondition.needsBodyFor?.({ kind: 'regex', field: 'subject', pattern: '.' })).toBe(false)
  })
})

describe('from / subject：子串、大小写不敏感', () => {
  it('名字与地址都在匹配范围内', () => {
    expect(fromCondition.test({ kind: 'from', any: ['notifications@github.com'] }, { summary: mail(), accountName: 'a' })).toBe(true)
    expect(fromCondition.test({ kind: 'from', any: ['github'] }, { summary: mail(), accountName: 'a' })).toBe(true)
    expect(fromCondition.test({ kind: 'from', any: ['GITHUB'] }, { summary: mail(), accountName: 'a' })).toBe(true)
    expect(fromCondition.test({ kind: 'from', any: ['gitlab'] }, { summary: mail(), accountName: 'a' })).toBe(false)
  })

  it('空组判为不命中——写歪胜过匹配一切', () => {
    expect(fromCondition.test({ kind: 'from' }, { summary: mail(), accountName: 'a' })).toBe(false)
  })
})

describe('header：最有价值的那个条件', () => {
  it('给了 name 不给 any 时，判「有没有这个头」', () => {
    const withHeader = mail({ headers: { 'list-id': 'Free-LZJ/free-dsh-plugins <x>' } })
    expect(headerCondition.test({ kind: 'header', name: 'list-id' }, { summary: withHeader, accountName: 'a' })).toBe(true)
    expect(headerCondition.test({ kind: 'header', name: 'list-id' }, { summary: mail(), accountName: 'a' })).toBe(false)
  })

  it('头部名大小写不敏感', () => {
    const withHeader = mail({ headers: { 'list-unsubscribe': '<mailto:x@y>' } })
    expect(headerCondition.test({ kind: 'header', name: 'List-Unsubscribe' }, { summary: withHeader, accountName: 'a' })).toBe(true)
  })

  it('给了 any 就要求子串命中', () => {
    const withHeader = mail({ headers: { 'list-id': 'Free-LZJ/free-dsh-plugins <x>' } })
    const spec = { kind: 'header' as const, name: 'list-id', any: ['free-dsh-plugins'] }
    expect(headerCondition.test(spec, { summary: withHeader, accountName: 'a' })).toBe(true)
    expect(headerCondition.test({ ...spec, any: ['other-repo'] }, { summary: withHeader, accountName: 'a' })).toBe(false)
  })

  it('头部存在但是空串时仍算「有」；缺失才是没有', () => {
    const empty = mail({ headers: { 'list-id': '' } })
    expect(headerCondition.test({ kind: 'header', name: 'list-id' }, { summary: empty, accountName: 'a' })).toBe(true)
    // 但要求子串命中时空串匹配不上任何非空 needle。
    expect(headerCondition.test({ kind: 'header', name: 'list-id', any: ['x'] }, { summary: empty, accountName: 'a' })).toBe(false)
  })
})

describe('regex：编译失败在加载期就被拦住', () => {
  it('写错的正则拒绝整份规则文件，并指出是哪条规则', () => {
    const parsed = parseRules(`
- id: bad
  name: 坏正则
  when:
    - kind: regex
      field: subject
      pattern: "([unclosed"
  then:
    - kind: markRead
`)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('坏正则')
  })

  it('能编译的正则按字段匹配', () => {
    const spec = { kind: 'regex' as const, field: 'subject' as const, pattern: '^run failed' }
    expect(regexCondition.test(spec, { summary: mail(), accountName: 'a' })).toBe(true)
    expect(regexCondition.test({ ...spec, pattern: '^nothing' }, { summary: mail(), accountName: 'a' })).toBe(false)
  })
})

describe('attachment：第一版只看「有没有附件」', () => {
  it('has 缺省表示要求有附件', () => {
    expect(attachmentCondition.test({ kind: 'attachment' }, { summary: mail({ hasAttachments: true }), accountName: 'a' })).toBe(true)
    expect(attachmentCondition.test({ kind: 'attachment' }, { summary: mail(), accountName: 'a' })).toBe(false)
    expect(attachmentCondition.test({ kind: 'attachment', has: false }, { summary: mail(), accountName: 'a' })).toBe(true)
  })
})

describe('classifier：模型只能给标签', () => {
  const ask = async () => ({ label: 'promo', confidence: 0.9 })

  it('答案落在允许集合里才算命中', async () => {
    const matched = await classifierCondition.test(
      { kind: 'classifier', labels: ['promo', 'work'] },
      { summary: mail(), accountName: 'a', body: 'text', classify: ask },
    )
    expect(matched).toBe(true)
  })

  it('答案不在允许集合里判为不命中', async () => {
    const matched = await classifierCondition.test(
      { kind: 'classifier', labels: ['work'] },
      { summary: mail(), accountName: 'a', body: 'text', classify: ask },
    )
    expect(matched).toBe(false)
  })

  it('uncertain 判为不命中——宁可留在收件箱', async () => {
    const matched = await classifierCondition.test(
      { kind: 'classifier', labels: ['promo'] },
      { summary: mail(), accountName: 'a', body: 't', classify: async () => ({ label: 'uncertain', confidence: 0 }) },
    )
    expect(matched).toBe(false)
  })

  it('没装分类通道时安静地判不命中，而不是抛错', async () => {
    const matched = await classifierCondition.test(
      { kind: 'classifier', labels: ['promo'] },
      { summary: mail(), accountName: 'a', body: 't' },
    )
    expect(matched).toBe(false)
  })
})

describe('简写条件形态', () => {
  it('`- from: [...]` 能被收成一样的东西', () => {
    expect(normalizeCondition({ from: ['a@b.c'] })).toEqual({ kind: 'from', any: ['a@b.c'] })
  })
})
