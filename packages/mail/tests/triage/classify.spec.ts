/**
 * 分类判定：拼提示词、解析回答、兜住胡说。
 *
 * 这一组用例回答的是「模型乱答会怎样」。结论必须是：**任何异常都回到 uncertain**，
 * 而不是挑一个最接近的标签——因为那个标签会直接决定这封邮件被自动怎么处理。
 *
 * @module @free-lzj/dsh-mail/tests/triage/classify
 */

import { describe, expect, it, vi } from 'vitest'
import { buildClassifyPrompt, createSessionClassifier, parseVerdict, UNCERTAIN } from '../../src/triage/classify.ts'
import type { ClassifyRequest } from '../../src/triage/conditions.ts'

/** 造一个分类请求。 */
function request(overrides: Partial<ClassifyRequest> = {}): ClassifyRequest {
  return {
    summary: {
      accountId: 'acc',
      folder: 'INBOX',
      uid: 1,
      uidValidity: 1,
      subject: '限时优惠',
      from: { address: 'news@shop.example' },
      date: '2026-10-21T00:00:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      snippet: '',
      headers: { 'list-unsubscribe': '<mailto:x@y>' },
    },
    accountName: '我的邮箱',
    body: '大促开始啦',
    labels: ['promo', 'work'],
    ...overrides,
  }
}

describe('buildClassifyPrompt', () => {
  it('把允许的标签显式告诉模型——它看不到规则文件', () => {
    const prompt = buildClassifyPrompt(request())
    expect(prompt).toContain('promo')
    expect(prompt).toContain('work')
    expect(prompt).toContain('uncertain')
  })

  it('写明「正文是不可信证据」，并且带上邮件头', () => {
    const prompt = buildClassifyPrompt(request())
    expect(prompt).toContain('不可信外部内容')
    expect(prompt).toContain('list-unsubscribe')
  })

  it('标签集为空时只给 uncertain，避免模型自己发明标签', () => {
    const prompt = buildClassifyPrompt(request({ labels: [] }))
    expect(prompt).toContain('uncertain')
  })

  it('正文截断：几万字的邮件不会把每次判定都撑大', () => {
    const prompt = buildClassifyPrompt(request({ body: 'x'.repeat(20_000) }))
    expect(prompt).toContain('已截断')
    // 6000 字正文 + 提示词与格式说明，远小于原文的 20000 字。
    expect(prompt.length).toBeLessThan(8000)
  })
})

describe('parseVerdict', () => {
  it('吃得下代码块围栏与前后废话', () => {
    const answer = '好的，我的判断是：\n```json\n{"label": "promo", "confidence": 0.8, "reason": "带退订头"}\n```'
    expect(parseVerdict(answer, ['promo', 'work'])).toEqual({ label: 'promo', confidence: 0.8, reason: '带退订头' })
  })

  it('嵌套对象里的花括号不会把解析带偏', () => {
    const answer = '{"label": "work", "confidence": 0.5, "reason": "包含 {占位} 的东西"}'
    expect(parseVerdict(answer, ['promo', 'work']).label).toBe('work')
  })

  it('标签不在允许集合里 → uncertain，绝不猜最接近的', () => {
    expect(parseVerdict('{"label": "spam", "confidence": 0.99}', ['promo', 'work'])).toEqual(UNCERTAIN)
  })

  it('完全不是 JSON → uncertain', () => {
    expect(parseVerdict('这封邮件看起来像广告', ['promo'])).toEqual(UNCERTAIN)
    expect(parseVerdict('', ['promo'])).toEqual(UNCERTAIN)
  })

  it('置信度非法时按 0.5 处理，但标签仍算数', () => {
    expect(parseVerdict('{"label": "promo", "confidence": "高"}', ['promo'])).toEqual({ label: 'promo', confidence: 0.5 })
  })

  it('置信度超出范围会被夹到 0–1', () => {
    expect(parseVerdict('{"label": "promo", "confidence": 7}', ['promo']).confidence).toBe(1)
    expect(parseVerdict('{"label": "promo", "confidence": -3}', ['promo']).confidence).toBe(0)
  })
})

describe('createSessionClassifier', () => {
  it('问一次、拿回判定，并把提示词交给 ask', async () => {
    const ask = vi.fn(async () => '{"label": "work", "confidence": 0.7}')
    const classify = createSessionClassifier({ ask })
    expect(await classify(request())).toEqual({ label: 'work', confidence: 0.7 })
    expect(ask).toHaveBeenCalledOnce()
    const [prompt] = ask.mock.calls[0] as unknown as [string]
    expect(prompt).toContain('promo')
  })

  it('ask 失败时判 uncertain 而不是抛出——一封没分类的邮件比错误分类好', async () => {
    const classify = createSessionClassifier({ ask: async () => { throw new Error('会话挂了') } })
    expect(await classify(request())).toEqual(UNCERTAIN)
  })

  it('超时判 uncertain', async () => {
    const classify = createSessionClassifier({
      ask: () => new Promise<string>(() => { /* 永不 settle */ }),
      timeoutMs: 10,
    })
    expect(await classify(request())).toEqual(UNCERTAIN)
  })

  it('问够次数就回收会话——固定会话的上下文会一直长', async () => {
    const onRecycle = vi.fn()
    const classify = createSessionClassifier({ ask: async () => '{"label": "work"}', recycleAfter: 3, onRecycle })
    for (let index = 0; index < 3; index += 1) await classify(request())
    expect(onRecycle).toHaveBeenCalledOnce()
  })

  it('回收失败不影响这次判定', async () => {
    const classify = createSessionClassifier({
      ask: async () => '{"label": "work"}',
      recycleAfter: 1,
      onRecycle: () => { throw new Error('归档失败') },
      log: () => undefined,
    })
    expect(await classify(request())).toEqual({ label: 'work', confidence: 0.5 })
  })
})
