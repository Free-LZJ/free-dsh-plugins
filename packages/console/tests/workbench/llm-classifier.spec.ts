/**
 * The model-backed classifier.
 *
 * The two promises worth testing are not "the model is smart": they are **it never
 * throws** (a failed classification must not fail the ingest) and **it never
 * invents a kind** (an answer outside the board's vocabulary falls back rather
 * than routing a card somewhere real). Both are pinned here against a fake model.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/llm-classifier
 */

import { describe, expect, it } from 'vitest'
import { LlmClassifier, parseAnswer, type LlmChunkLike, type LlmPortLike } from '../../src/workbench/llm-classifier.ts'
import { RuleClassifier } from '../../src/workbench/classifier.ts'
import type { WorkbenchEvent } from '../../src/protocol.ts'

/** The event every test classifies. */
const event: WorkbenchEvent = { source: 'webhook', title: '页面报错', body: '打开首页就 500' }

/** A fake llm that streams the given chunks. */
function llm(chunks: readonly LlmChunkLike[] | (() => never), calls: Record<string, unknown>[] = []): LlmPortLike {
  return {
    prepareCall: async (request) => {
      calls.push(request)
      return {
        config: { provider: 'fake', model: 'fake-1' },
        stream: async function* () {
          if (typeof chunks === 'function') chunks()
          for (const chunk of chunks as readonly LlmChunkLike[]) yield chunk
        },
      }
    },
  }
}

/** A classifier over that fake. */
function classifier(port: LlmPortLike) {
  return new LlmClassifier({
    llm: port,
    route: () => ({ provider: 'fake', model: 'fake-1' }),
    fallback: new RuleClassifier(),
    timeoutMs: 1_000,
  })
}

describe('LlmClassifier', () => {
  it('answers with the model\'s verdict, in the board\'s shape', async () => {
    const answer = await classifier(llm([
      { type: 'text-delta', text: '{"kind":"bug","priority":"urgent","conf' },
      { type: 'text-delta', text: 'idence":0.82,"reason":"页面 500"}' },
    ])).classify(event)
    expect(answer.kind).toBe('bug')
    expect(answer.priority).toBe('urgent')
    expect(answer.confidence).toBe(0.82)
    expect(answer.reasons[0]?.code).toBe('classify-llm')
  })

  it('falls back instead of throwing when the model call fails', async () => {
    // ingest 不能因为分类器失败而失败。
    const port: LlmPortLike = {
      prepareCall: async () => {
        throw new Error('no network')
      },
    }
    const answer = await classifier(port).classify(event)
    expect(answer.kind).toBe('bug')
    expect(answer.reasons[0]?.code).toBe('classify-llm-failed')
    expect(answer.reasons[0]?.params?.['detail']).toContain('no network')
  })

  it('falls back when the answer is not readable', async () => {
    const answer = await classifier(llm([{ type: 'text-delta', text: '我觉得这是一个 bug' }])).classify(event)
    expect(answer.reasons[0]?.code).toBe('classify-llm-unreadable')
    expect(answer.kind).toBe('bug')
  })

  it('falls back when no model is named', async () => {
    const port = llm([{ type: 'text-delta', text: '{}' }])
    const runs = new LlmClassifier({ llm: port, route: () => undefined, fallback: new RuleClassifier() })
    const answer = await runs.classify(event)
    expect(answer.reasons[0]?.code).toBe('classify-llm-no-model')
  })

  it('asks with the configured route and a bounded token budget', async () => {
    const calls: Record<string, unknown>[] = []
    await classifier(llm([{ type: 'text-delta', text: '{"kind":"consult","priority":"low","confidence":0.6,"reason":"问句"}' }], calls))
      .classify(event)
    expect(calls[0]).toMatchObject({ provider: 'fake', model: 'fake-1', maxTokens: 200 })
  })
})

describe('parseAnswer', () => {
  it('reads JSON out of prose and fences', () => {
    expect(parseAnswer('```json\n{"kind":"bug","priority":"high","confidence":0.7,"reason":"x"}\n```')?.kind).toBe('bug')
  })

  it('rejects a kind the board does not have', () => {
    // 「性能 bug」不能靠许愿变成 bug。
    expect(parseAnswer('{"kind":"performance bug","priority":"high","confidence":0.9,"reason":"x"}')).toBeUndefined()
  })

  it('rejects a priority the board does not have', () => {
    expect(parseAnswer('{"kind":"bug","priority":"critical","confidence":0.9,"reason":"x"}')).toBeUndefined()
  })

  it('rejects a confidence outside 0..1, and a non-number', () => {
    expect(parseAnswer('{"kind":"bug","priority":"high","confidence":1.5,"reason":"x"}')).toBeUndefined()
    expect(parseAnswer('{"kind":"bug","priority":"high","confidence":"high","reason":"x"}')).toBeUndefined()
  })

  it('keeps a missing reason usable by echoing the kind', () => {
    expect(parseAnswer('{"kind":"consult","priority":"low","confidence":0.5}')?.reason).toBe('consult')
  })
})
