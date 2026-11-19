/**
 * Where a GitHub notification's `{repo}` comes from.
 *
 * The GitHub sub-flow opens a session in `{repoRoot}/{repo}`, so this value decides
 * whether that node can run at all. It used to be filled with the root folder
 * itself, which only "worked" when the root happened to be a repo; the real
 * answer is in `List-Id`, and that is what these cases pin down.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { repoSenderOf, templateValuesOf, type MailEventPayload } from '../src/connector.ts'
import { parseTriageHeaders } from '../src/headers.ts'

/** A real-shaped GitHub notification; its `List-Id` is not folded into `<...>`. */
const github = readFileSync(new URL('./fixtures/github.eml', import.meta.url))

describe('repoSenderOf', () => {
  it('reads the coordinate in front of the angle brackets', () => {
    expect(repoSenderOf({ 'list-id': 'free-lzj/dsh-plugins' })).toEqual({ owner: 'free-lzj', repo: 'dsh-plugins' })
    expect(repoSenderOf({ 'list-id': 'free-lzj/dsh-plugins <dsh-plugins.github.com>' })).toEqual({
      owner: 'free-lzj',
      repo: 'dsh-plugins',
    })
    // The header parser hands over the value it extracted, quotes and all.
    expect(repoSenderOf({ 'list-id': '"Free-Lzj/Dsh-Plugins" <dsh-plugins.github.com>' })).toEqual({
      owner: 'Free-Lzj',
      repo: 'Dsh-Plugins',
    })
  })

  it('falls back to the host only when the coordinate is missing', () => {
    // A repo name may contain dots, so the host alone is ambiguous; when the
    // coordinate is there it always wins.
    expect(repoSenderOf({ 'list-id': '<repo.owner.github.com>' })).toEqual({ repo: 'repo', owner: 'owner' })
    expect(repoSenderOf({ 'list-id': '<github.com>' })).toBeUndefined()
  })

  it('refuses anything that is not a GitHub notification', () => {
    // Not GitHub: a newsletter's List-Id must not turn into a repo path.
    expect(repoSenderOf({ 'list-id': '<news.example.com>' })).toBeUndefined()
    expect(repoSenderOf({ 'list-id': 'Some List <some.list.example.com>' })).toBeUndefined()
    // No List-Id at all — the caller then leaves `{repo}` out and the template
    // reports the missing variable instead of building a bogus path.
    expect(repoSenderOf({})).toBeUndefined()
  })

  it('reads the header off a real GitHub message', () => {
    expect(repoSenderOf(parseTriageHeaders(github))).toEqual({ owner: 'free-lzj', repo: 'dsh-plugins' })
  })
})

describe('templateValuesOf', () => {
  /** The smallest payload the templates care about. */
  function payload(): MailEventPayload {
    return {
      accountId: 'qq',
      accountName: '工作邮箱',
      folder: 'INBOX',
      uid: 229676,
      uidValidity: 3,
      from: { address: 'notifications@github.com', name: 'GitHub' },
      subject: 'Run failed: E2E',
      date: '2026-11-10T00:00:00Z',
      headers: { 'list-id': 'free-lzj/dsh-plugins <dsh-plugins.github.com>' },
      snippet: '工作流失败',
      seen: false,
      flagged: false,
      hasAttachments: false,
    }
  }

  it('injects the repo, not the root folder', () => {
    const values = templateValuesOf(payload(), 'D:/dsh-work')
    expect(values['repo']).toBe('dsh-plugins')
    expect(values['owner']).toBe('free-lzj')
    expect(values['repoRoot']).toBe('D:/dsh-work')
  })

  it('leaves repo out when the mail is not from GitHub', () => {
    const plain = payload()
    const values = templateValuesOf({ ...plain, headers: {} }, '')
    expect(values['repo']).toBeUndefined()
    expect(values['owner']).toBeUndefined()
    expect(values['repoRoot']).toBeUndefined()
  })
})
