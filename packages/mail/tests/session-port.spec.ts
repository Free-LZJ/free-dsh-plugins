/**
 * The mail-side session port.
 *
 * This port is how a rule's `session` action becomes a real conversation, and it
 * is the piece that was **never wired**: it used to look for `sessionController`
 * and `workspaceRegistry`, neither of which the host composes, so every `session`
 * action quietly answered "no session service". The names and shapes below are
 * the ones verified against a running host (`docs/workbench-session-api.md`).
 *
 * @module @free-lzj/dsh-mail/tests/session-port
 */

import { describe, expect, it } from 'vitest'
import { buildSessionPort } from '../src/triage/mount.ts'
import { mailTemplateValues } from '../src/triage/actions/context.ts'

/** One agent stub, recording what it was asked. */
function agent(sessionId = 'session-1') {
  const calls = { appended: [] as { type: string; data: unknown }[], followed: [] as string[] }
  return {
    calls,
    session: {
      id: sessionId,
      append: (type: string, data: unknown) => {
        calls.appended.push({ type, data })
        return undefined
      },
    },
    followup: (message: { content?: readonly { text?: string }[] }) => {
      calls.followed.push(message.content?.[0]?.text ?? '')
      return undefined
    },
  }
}

describe('mailTemplateValues', () => {
  it('projects the values a template can use, and drops the empty ones', () => {
    const values = mailTemplateValues({ summary: { subject: '限时优惠', from: { address: 'a@b.com' } }, accountName: '工作邮箱', ruleName: '推广' }, 'D:/open')
    expect(values).toMatchObject({ subject: '限时优惠', account: '工作邮箱', rule: '推广', from: 'a@b.com', repo: 'D:/open' })
    // 没有正文就**不放这个键**：{body} 填充时本来就是空串，塞个空键只会让投影看起来有值。
    expect(values).not.toHaveProperty('body')
  })

  it('leaves the repo out when the machine names none', () => {
    expect(mailTemplateValues({ summary: { subject: 'x' }, accountName: 'a', ruleName: 'r' }, '')).not.toHaveProperty('repo')
  })
})

describe('buildSessionPort', () => {
  it('answers nothing when the host cannot create sessions', () => {
    expect(buildSessionPort(undefined)).toBeUndefined()
    expect(buildSessionPort({})).toBeUndefined()
  })

  it('creates the conversation and remembers its agent', async () => {
    const made = agent('session-7')
    const port = buildSessionPort({ createSession: async () => ({ agent: made }) })
    await expect(port?.createSession({ cwd: 'C:/repo' })).resolves.toEqual({ sessionId: 'session-7' })
  })

  it('refuses a creation that reports no session id', async () => {
    const port = buildSessionPort({ createSession: async () => ({ agent: { session: {}, followup: () => undefined } }) })
    await expect(port?.createSession({ cwd: 'C:/repo' })).rejects.toThrow('no session id')
  })

  it('renames by appending a session/title event', async () => {
    const made = agent('session-7')
    const port = buildSessionPort({ createSession: async () => ({ agent: made }) })
    await port?.createSession({ cwd: 'C:/repo' })
    await port?.rename('session-7', 'Jira EXEPD-123')
    expect(made.calls.appended[0]).toEqual({
      type: 'session/title',
      data: { title: 'Jira EXEPD-123', messageSeqs: [], source: { kind: 'user' } },
    })
  })

  it('delivers the first message through the agent', async () => {
    const made = agent('session-7')
    const port = buildSessionPort({ createSession: async () => ({ agent: made }) })
    await port?.createSession({ cwd: 'C:/repo' })
    await port?.followup('session-7', '看一下这封邮件', { rule: 'jira' })
    expect(made.calls.followed).toEqual(['看一下这封邮件'])
  })

  it('refuses to talk to a session it did not create', async () => {
    // 别的插件建的会话不归这里管：宁可报错，也不要投错会话。
    const port = buildSessionPort({ createSession: async () => ({ agent: agent() }) })
    await expect(port?.followup('somebody-else', '喂', {})).rejects.toThrow('was not created by this plugin')
  })

  it('accepts the workspace attach as a no-op instead of pretending to move the session', async () => {
    const port = buildSessionPort({ createSession: async () => ({ agent: agent() }) })
    await expect(port?.attachSession('C:/repo', 'session-1')).resolves.toBeUndefined()
  })
})
