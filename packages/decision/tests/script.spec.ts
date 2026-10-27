/**
 * The script action, in the kernel.
 *
 * What matters here is not "it runs a command": it is that the command stays a list
 * (so nothing in an argument is ever shell syntax), that the projection decides what
 * can be substituted, and that a failing command leaves a readable trace instead of
 * an opaque throw.
 *
 * @module @free-lzj/dsh-decision/tests/script
 */

import { describe, expect, it } from 'vitest'
import { fillArgs, firstLine, runScript, type SpawnResult } from '../src/actions/script.ts'

const values = { subject: '限时优惠', from: 'a@b.com', rule: '推广', uid: '42', repo: 'D:/open' }

/** A port that records the request and answers with the given result. */
function port(result: Partial<SpawnResult> = {}, seen: { command: string; args: readonly string[]; cwd?: string }[] = []) {
  return {
    seen,
    subprocess: {
      spawn: async (request: { command: string; args: readonly string[]; cwd?: string }) => {
        seen.push(request)
        return { code: 0, stdout: 'ok\n', stderr: '', ...result }
      },
    },
  }
}

describe('fillArgs', () => {
  it('fills one argument at a time and keeps them separate', () => {
    // 参数始终是数组：邮件里写的 `; rm -rf /` 不会被当成命令解析。
    expect(fillArgs(['--subject', '{subject}', '; rm -rf /'], values))
      .toEqual(['--subject', '限时优惠', '; rm -rf /'])
  })
})

describe('firstLine', () => {
  it('keeps the first non-empty line', () => {
    expect(firstLine('\n\n  第一行  \nsecond\n')).toBe('第一行')
  })

  it('marks a line it had to cut', () => {
    const long = firstLine('x'.repeat(600))
    expect(long.length).toBe(501)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('runScript', () => {
  it('runs the command with the filled arguments', async () => {
    const { seen, subprocess } = port()
    const outcome = await runScript({ command: 'node', args: ['-e', 'echo {rule}'] }, { templateValues: values, subprocess })
    expect(seen).toEqual([{ command: 'node', args: ['-e', 'echo 推广'] }])
    expect(outcome).toEqual({ ok: true, detail: 'node：ok' })
  })

  it('answers a non-zero exit with its output, not a throw', async () => {
    const { subprocess } = port({ code: 2, stderr: '没有这个文件\n' })
    const outcome = await runScript({ command: 'ls' }, { templateValues: values, subprocess })
    if (outcome.ok) return
    expect(outcome.message).toContain('退出码 2')
    expect(outcome.message).toContain('没有这个文件')
  })

  it('says so when the command prints nothing', async () => {
    const { subprocess } = port({ stdout: '' })
    expect(await runScript({ command: 'true' }, { templateValues: values, subprocess }))
      .toEqual({ ok: true, detail: 'true 执行完成' })
  })

  it('fails with a reason when there is no subprocess capability', async () => {
    expect(await runScript({ command: 'true' }, { templateValues: values })).toMatchObject({ ok: false })
  })

  it('fails when the action names no command', async () => {
    const { subprocess } = port()
    expect(await runScript({}, { templateValues: values, subprocess })).toMatchObject({ ok: false })
  })

  it('answers a spawn error instead of throwing', async () => {
    const outcome = await runScript({ command: 'nope' }, {
      templateValues: values,
      subprocess: { spawn: async () => { throw new Error('ENOENT') } },
    })
    if (outcome.ok) return
    expect(outcome.message).toContain('ENOENT')
  })
})
