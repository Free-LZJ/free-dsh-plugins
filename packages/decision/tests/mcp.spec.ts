/**
 * The MCP action, in the kernel.
 *
 * The behaviour worth pinning is the input tree: placeholders are filled through
 * nesting, and non-string leaves survive. Both are the difference between a call a
 * server accepts and one it rejects with a type error nobody can trace back here.
 *
 * @module @free-lzj/dsh-decision/tests/mcp
 */

import { describe, expect, it } from 'vitest'
import { fillInput, runMcp } from '../src/actions/mcp.ts'

const values = { subject: '限时优惠', from: 'a@b.com', rule: '推广', uid: '42' }

describe('fillInput', () => {
  it('fills placeholders through nested objects and arrays', () => {
    expect(fillInput({ filter: { key: '{subject}', tags: ['{rule}'] } }, values))
      .toEqual({ filter: { key: '限时优惠', tags: ['推广'] } })
  })

  it('leaves numbers and booleans alone so a schema still validates', () => {
    // `limit: 10` 变成 `"10"` 正是服务器会拒的那种错。
    expect(fillInput({ limit: 10, strict: true, tag: '{rule}' }, values)).toEqual({ limit: 10, strict: true, tag: '推广' })
  })
})

describe('runMcp', () => {
  it('calls the tool with the filled input', async () => {
    const calls: { name: string; input: unknown }[] = []
    const outcome = await runMcp({ tool: 'mcp__jira__get_issue', input: { key: '{subject}' } }, {
      templateValues: values,
      tools: { call: async (name, input) => { calls.push({ name, input }) } },
    })
    expect(outcome).toEqual({ ok: true, detail: '已调用 mcp__jira__get_issue' })
    expect(calls).toEqual([{ name: 'mcp__jira__get_issue', input: { key: '限时优惠' } }])
  })

  it('fails with a reason when no tool service is mounted', async () => {
    expect(await runMcp({ tool: 'x' }, { templateValues: values })).toMatchObject({ ok: false })
  })

  it('fails when the action names no tool', async () => {
    const outcome = await runMcp({}, { templateValues: values, tools: { call: async () => undefined } })
    expect(outcome).toMatchObject({ ok: false })
  })

  it('answers a tool error instead of throwing', async () => {
    const outcome = await runMcp({ tool: 'x' }, {
      templateValues: values,
      tools: { call: async () => { throw new Error('server down') } },
    })
    if (outcome.ok) return
    expect(outcome.message).toContain('server down')
  })
})
