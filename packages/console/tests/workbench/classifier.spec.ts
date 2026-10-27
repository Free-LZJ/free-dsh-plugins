/**
 * The rule classifier: what it judges, and how sure it is.
 *
 * The fallback must be conservative by construction — an event that matches
 * nothing, or two kinds equally, is `unknown` with a low confidence, because
 * routing holds those for a human instead of dispatching on a guess.
 *
 * @module @free-lzj/dsh-console/tests/workbench/classifier
 */

import { describe, expect, it } from 'vitest'
import { RuleClassifier } from '../../src/workbench/classifier.ts'

const classify = (title: string, body?: string) => new RuleClassifier().classify({
  source: 'webhook',
  title,
  ...(body === undefined ? {} : { body }),
})

describe('the rule classifier', () => {
  it('calls a crash a bug, urgent when it is on production', () => {
    const result = classify('线上服务崩溃，无法打开')
    expect(result.kind).toBe('bug')
    expect(result.priority).toBe('urgent')
    expect(result.executor).toBe('dsh')
    expect(result.confidence).toBeGreaterThanOrEqual(0.6)
  })

  it('reads a Jira-style project key off the event', () => {
    const result = classify('EXEPD-222269 页面报错')
    expect(result.kind).toBe('bug')
    expect(result.project).toBe('EXEPD')
  })

  it('calls a question a consult and suggests no executor', () => {
    const result = classify('请问这个接口怎么用')
    expect(result.kind).toBe('consult')
    expect(result.executor).toBeUndefined()
  })

  it('calls a feature wish a requirement bound for Codex', () => {
    const result = classify('希望新增导出功能')
    expect(result.kind).toBe('requirement')
    expect(result.executor).toBe('codex')
  })

  it('answers unknown, with a low confidence, when nothing matches', () => {
    const result = classify('今天天气不错')
    expect(result.kind).toBe('unknown')
    expect(result.confidence).toBeLessThan(0.6)
    // 判据是代码 + 参数，文字由页面出（§9 #9）。
    expect(result.reasons).toEqual([{ code: 'classify-none' }])
  })

  it('answers unknown when two kinds tie, and says which two', () => {
    const result = classify('报错咨询')
    expect(result.kind).toBe('unknown')
    expect(result.confidence).toBeLessThan(0.6)
    // 代码 + 参数：页面自己把这些参数拼成一句话。
    expect(result.reasons).toEqual([{ code: 'classify-ambiguous', params: { first: 'bug', second: 'consult' } }])
  })

  it('grows more confident with corroborating keywords', () => {
    const one = classify('页面报错')
    const many = classify('页面报错，服务异常，无法打开')
    expect(many.confidence).toBeGreaterThan(one.confidence)
  })
})
