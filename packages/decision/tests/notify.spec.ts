/**
 * The notify action, now in the kernel.
 *
 * Two behaviours matter more than the wording: a deployment without a workbench must
 * not fail the action, and a console that only offers `raise` must still be told.
 * Both were carried over from the mail version rather than invented here.
 *
 * @module @free-lzj/dsh-decision/tests/notify
 */

import { describe, expect, it } from 'vitest'
import { renderNotifyTitle, runNotify, type NotifyContext } from '../src/actions/notify.ts'

/** A context over the given console, recording the log. */
function context(overrides: Partial<NotifyContext> = {}): NotifyContext & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    templateValues: { subject: '限时优惠', from: 'a@b.com', rule: '推广', account: '工作邮箱' },
    source: 'mail',
    log: (line) => lines.push(line),
    ...overrides,
  }
}

describe('renderNotifyTitle', () => {
  it('fills the default template from the projection', () => {
    expect(renderNotifyTitle({}, context())).toBe('推广: 限时优惠')
  })

  it('falls back to the subject when a template renders empty', () => {
    // 空标题是一条没法处置的通知——模板最容易犯的错就是这个。
    expect(renderNotifyTitle({ title: '{nope}' }, context())).toBe('限时优惠')
  })
})

describe('runNotify', () => {
  it('sends through notify when the console has it', async () => {
    const sent: unknown[] = []
    const outcome = await runNotify({ tone: 'warn' }, context({
      console: { notify: async (notice) => { sent.push(notice) } },
    }))
    expect(outcome).toEqual({ ok: true, detail: '已通知：推广: 限时优惠' })
    expect(sent).toEqual([{ title: '推广: 限时优惠', body: 'a@b.com · 推广', tone: 'warn', source: 'mail' }])
  })

  it('falls back to raise when the console has only that', async () => {
    const raised: unknown[] = []
    await runNotify({}, context({
      console: { raise: async (item) => { raised.push(item) } },
    }))
    expect(raised).toHaveLength(1)
  })

  it('succeeds, and says so in the log, when there is no workbench at all', async () => {
    const ctx = context()
    const outcome = await runNotify({}, ctx)
    expect(outcome.ok).toBe(true)
    expect(ctx.lines.join('\n')).toContain('未安装工作台')
  })

  it('answers a console error as a failure with the reason', async () => {
    const outcome = await runNotify({}, context({
      console: { notify: async () => { throw new Error('通道关了') } },
    }))
    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) return
    expect(outcome.message).toContain('通道关了')
  })
})
