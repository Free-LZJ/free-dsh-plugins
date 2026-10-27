/**
 * The session action, in the kernel.
 *
 * The order is the thing: attach before rename before permission before the first
 * message. A permission set after the follow-up is a permission that never applied to
 * the message that needed it. And a session that exists is never rolled back — a failed
 * hand-off must still answer with its id.
 *
 * @module @free-lzj/dsh-decision/tests/session
 */

import { describe, expect, it } from 'vitest'
import { runSession, type SessionPort } from '../src/actions/session.ts'

/** A port that records the calls in order. */
function port(options: { failAt?: 'attach' | 'followup' } = {}) {
  const calls: string[] = []
  const value: SessionPort = {
    createSession: async (request) => {
      calls.push(`create:${request.cwd}`)
      return { sessionId: 'session-1' }
    },
    attachSession: async (cwd, id) => {
      calls.push(`attach:${cwd}:${id}`)
      if (options.failAt === 'attach') throw new Error('工作区不认这个会话')
    },
    rename: async (id, title) => { calls.push(`rename:${id}:${title}`) },
    setPermission: (id, preset) => { calls.push(`permission:${id}:${preset}`) },
    followup: async (id, text) => {
      calls.push(`followup:${id}:${text}`)
      if (options.failAt === 'followup') throw new Error('agent 忙')
    },
  }
  return { calls, sessions: value }
}

const request = {
  workspace: 'D:/repo',
  title: '[邮件] 推广',
  prompt: '正文',
  permissionPreset: 'readonly',
  source: { kind: 'plugin:dsh-mail' },
}

describe('runSession', () => {
  it('runs the steps in the only order that works', async () => {
    const { calls, sessions } = port()
    const outcome = await runSession(request, { sessions, log: () => undefined })
    expect(calls).toEqual([
      'create:D:/repo',
      'attach:D:/repo:session-1',
      'rename:session-1:[邮件] 推广',
      'permission:session-1:readonly',
      'followup:session-1:正文',
    ])
    expect(outcome).toEqual({ ok: true, detail: '已在「D:/repo」新建会话', sessionId: 'session-1' })
  })

  it('keeps the session and reports it when the hand-off fails', async () => {
    // 回滚一个可能已经收到消息的会话，比留着更糟。
    const { sessions } = port({ failAt: 'followup' })
    const outcome = await runSession(request, { sessions, log: () => undefined })
    if (outcome.ok) return
    expect(outcome.sessionId).toBe('session-1')
    expect(outcome.message).toContain('交接失败')
  })

  it('says so when the session service is missing', async () => {
    expect(await runSession(request, { log: () => undefined })).toMatchObject({ ok: false })
  })

  it('skips the permission step when none was named', async () => {
    const { calls, sessions } = port()
    const { permissionPreset: _omitted, ...withoutPreset } = request
    await runSession(withoutPreset, { sessions, log: () => undefined })
    expect(calls.some(call => call.startsWith('permission:'))).toBe(false)
  })

  it('fails without a session id when creation itself fails', async () => {
    const outcome = await runSession(request, {
      sessions: {
        ...port().sessions,
        createSession: async () => { throw new Error('没有配额') },
      },
      log: () => undefined,
    })
    if (outcome.ok) return
    expect(outcome.sessionId).toBeUndefined()
    expect(outcome.message).toContain('没有配额')
  })
})
