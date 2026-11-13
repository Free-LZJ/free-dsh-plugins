/**
 * 分类计划：这次要不要问模型、问哪些标签。
 *
 * 两条边界：没配模型时整段跳过（否则每一封邮件的链里都会多出一条红的假失败），
 * 配了就把所有规则的标签取并集去重——一封邮件只问一次模型。
 *
 * @module @free-lzj/dsh-mail/tests/classify
 */

import { describe, expect, it } from 'vitest'
import type { ActionSpecLike, ConditionSpecLike, Rule, Task, TaskContext, TaskEvent } from '@free-lzj/dsh-decision'
import { createMailClassify, MAIL_EVENT, pickLabel, type LlmLike, type MailEventPayload, type MailOpsLike } from '../src/connector.ts'
import { DEFAULT_CONFIG } from '../src/triage/config.ts'

/** 分类计划用不到真正的 IMAP，给一个什么都不做的实现。 */
const mail: MailOpsLike = {
  async fetchDetail() { return undefined },
  async listMailboxes() { return [] },
  async ensureFolder(_accountId, path) { return { ok: true, path } },
  async applyAction() { return { ok: true, applied: 0 } },
}

function classifyWith(model: string): ReturnType<typeof createMailClassify> {
  return createMailClassify({
    mail,
    config: () => ({ ...DEFAULT_CONFIG, model }),
    log: () => {},
    warn: () => {},
  })
}

function rule(id: string, labels: readonly string[], prompt?: string): Rule<ConditionSpecLike, ActionSpecLike> {
  const spec: ConditionSpecLike & { readonly labels: readonly string[]; readonly prompt?: string } =
    { kind: 'classifier', labels, ...(prompt === undefined ? {} : { prompt }) }
  return { id, name: id, enabled: true, priority: 10, when: [spec], then: [] }
}

describe('plan：要不要分类', () => {
  it('没配模型时不分类——不产生节点，也不花一次模型调用', () => {
    expect(classifyWith('').plan([rule('a', ['todo'])])).toBeUndefined()
  })

  it('没配模型 + 没有 classifier 规则时同样不分类', () => {
    expect(classifyWith('').plan([])).toBeUndefined()
  })

  it('配了模型就把标签取并集去重', () => {
    const plan = classifyWith('openviking/deepseek-v4.1-flash-1017')
      .plan([rule('a', ['todo', 'dev']), rule('b', ['dev', 'newsletter'])])

    expect(plan?.labels).toEqual(['todo', 'dev', 'newsletter'])
  })

  it('配了模型但没有 classifier 规则时不分类', () => {
    expect(classifyWith('openviking/deepseek-v4.1-flash-1017').plan([])).toBeUndefined()
  })

  it('规则里的 prompt（标签含义）要一起交给模型，相同的只留一份', () => {
    const plan = classifyWith('exe/deepseek-v4.1-flash-1017').plan([
      rule('a', ['todo'], 'todo 是真人来信'),
      rule('b', ['dev'], 'todo 是真人来信'),
    ])

    expect(plan?.prompt).toBe('todo 是真人来信')
  })

  it('不同的 prompt 按顺序拼接', () => {
    const plan = classifyWith('exe/deepseek-v4.1-flash-1017').plan([
      rule('a', ['todo'], '第一段'),
      rule('b', ['dev'], '第二段'),
    ])

    expect(plan?.prompt).toBe('第一段\n\n第二段')
  })

  it('没有 prompt 时只给标签集', () => {
    const plan = classifyWith('exe/deepseek-v4.1-flash-1017').plan([rule('a', ['todo'])])

    expect(plan).toEqual({ labels: ['todo'] })
  })
})

describe('pickLabel：模型回答 → 标签', () => {
  const labels = ['github-do', 'todo', 'dev'] as const

  it('整段就是一个标签', () => {
    expect(pickLabel('todo', labels)).toEqual({ label: 'todo', confidence: 0.9 })
  })

  it('带标点、空白、大小写也认', () => {
    expect(pickLabel('  TODO。\n', labels)).toEqual({ label: 'todo', confidence: 0.9 })
  })

  it('回答前面被塞了其它行时看最后一行', () => {
    expect(pickLabel('> OpenViking read: dev — done\n\ntodo', labels))
      .toEqual({ label: 'todo', confidence: 0.9 })
  })

  it('最后一行不是标签、正文里含标签时退回包含匹配', () => {
    expect(pickLabel('我觉得是 dev', labels)).toEqual({ label: 'dev', confidence: 0.8 })
  })

  it('答非所问一律 uncertain', () => {
    expect(pickLabel('I am not sure', labels)).toEqual({ label: 'uncertain', confidence: 0 })
  })

  it('空回答（思考吃光预算）不猜', () => {
    expect(pickLabel('   ', labels)).toEqual({ label: 'uncertain', confidence: 0 })
  })
})

describe('run：交给模型的请求形状', () => {
  const payload: MailEventPayload = {
    accountId: 'a',
    accountName: 'a',
    folder: 'INBOX',
    uid: 1,
    uidValidity: 1,
    subject: '关于下周评审',
    from: { address: 'wang@example.com' },
    date: '2026-11-13T02:00:00Z',
    headers: {},
    snippet: '下周二的评审会改到周三',
    seen: false,
    flagged: false,
    hasAttachments: false,
  }

  const task = {
    id: 'task-1', connector: 'mail', triggerId: 'mail:new', key: 'k',
    title: '关于下周评审', at: '2026-11-13T02:00:00Z', updatedAt: '2026-11-13T02:00:00Z',
    status: 'running', nodes: [], vars: {}, event: { type: MAIL_EVENT, source: 'mail', payload },
  } as unknown as Task

  const context: TaskContext = {
    task,
    event: task.event as TaskEvent,
    vars: {},
    node: { id: 'n1', kind: 'classify' },
    ports: {},
    now: new Date('2026-11-13T02:00:00Z'),
    log: () => {},
  }

  /** 一个记下请求、回一个标签的模型。 */
  function fakeLlm(seen: unknown[], answer = 'todo'): () => LlmLike {
    return () => ({
      async prepareCall() {
        return {
          config: { provider: 'exe', model: 'm' },
          async *stream(input: unknown) {
            seen.push(input)
            yield { type: 'text-delta', text: answer }
          },
        }
      },
    })
  }

  it('messages 的 content 必须是块数组——字符串会被宿主机当成空消息', async () => {
    const seen: unknown[] = []
    const node = createMailClassify({
      mail,
      config: () => ({ ...DEFAULT_CONFIG, model: 'exe/deepseek-v4.1-flash-1017' }),
      llm: fakeLlm(seen),
      log: () => {},
      warn: () => {},
    }).node

    const outcome = await node.run({ labels: ['todo', 'dev'] }, context)

    const input = seen[0] as { messages: { content: { type: string; text: string }[] }[] }
    expect(Array.isArray(input.messages[0]?.content)).toBe(true)
    expect(input.messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(input.messages[0]?.content[0]?.text).toContain('todo')
    expect(outcome.label).toBe('todo')
    expect(outcome.ok).toBe(true)
  })

  it('模型一个字都没回时，说明里带上收到的块类型', async () => {
    const node = createMailClassify({
      mail,
      config: () => ({ ...DEFAULT_CONFIG, model: 'exe/deepseek-v4.1-flash-1017' }),
      llm: () => ({
        async prepareCall() {
          return {
            config: { provider: 'exe', model: 'm' },
            async *stream() { yield { type: 'reasoning-delta', text: '想' } },
          }
        },
      }),
      log: () => {},
      warn: () => {},
    }).node

    const outcome = await node.run({ labels: ['todo'] }, context)

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('reasoning-delta×1')
  })
})
