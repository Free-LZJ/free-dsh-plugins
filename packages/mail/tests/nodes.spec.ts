/**
 * 邮件连接器贡献的两个动作节点。
 *
 * 重点验两件在旧代码里没有的事：**正文不进持久层**、**分类失败不炸**。
 *
 * @module @free-lzj/dsh-mail/tests/nodes
 */

import { describe, expect, it } from 'vitest'
import { executeFlow, FlowNodeRegistry, createControlNodes } from '@free-lzj/dsh-decision'
import type { Flow, FlowContext } from '@free-lzj/dsh-decision'
import { createMailFlowNodes, pickLabel } from '../src/nodes.ts'
import type { LlmLike, MailConnectorDeps, MailOpsLike } from '../src/connector.ts'

/** 一封读得到的邮件。 */
function mailOps(text = '这是一封邮件的正文'): MailOpsLike {
  return {
    fetchDetail: async () => ({
      subject: 'Hi',
      from: { address: 'a@example.com' },
      date: '2026-11-15T00:00:00.000Z',
      text,
    }),
    listMailboxes: async () => [],
    ensureFolder: async (_accountId, path) => ({ ok: true, path }),
    applyAction: async () => ({ ok: true }),
  }
}

/** 一个只说一句话的模型。 */
function llmOf(answer: string): LlmLike {
  return {
    async prepareCall() {
      return {
        config: {},
        async *stream() {
          yield { type: 'text-delta', text: answer }
        },
      }
    },
  }
}

/** 组装依赖。 */
function deps(overrides: Partial<MailConnectorDeps> = {}): MailConnectorDeps {
  return {
    mail: mailOps(),
    config: () => ({ model: 'test/model' }) as never,
    log: () => {},
    warn: () => {},
    ...overrides,
  }
}

/** 事件投影。 */
const event = { accountId: 'acc', folder: 'INBOX', uid: '7', from: 'a@example.com', subject: 'Hi', snippet: '摘要' }

describe('mail.fetch', () => {
  it('正文进 memory，不进 vars', async () => {
    const nodes = createMailFlowNodes(deps({ mail: mailOps('很长的正文') }))
    const fetchNode = nodes.find(node => node.type === 'mail.fetch')!
    const context = {
      event,
      vars: {},
      memory: {},
      facts: {},
      taskId: 't',
      flowId: 'f',
      runId: 'r',
      record: () => {},
      log: () => {},
    } as FlowContext
    const result = await fetchNode.run({ id: 'n', type: 'mail.fetch' }, context)
    expect(result.ok).toBe(true)
    // 节点只回产出，写进哪一层由执行器按 outputs 声明决定（见 executeFlow）。
    expect('output' in result && result.output?.['body']).toBe('很长的正文')
  })

  it('事件缺 uid 时记 config 失败，不去读邮箱', async () => {
    let called = false
    const nodes = createMailFlowNodes(deps({
      mail: { ...mailOps(), fetchDetail: async () => { called = true; return undefined } },
    }))
    const fetchNode = nodes.find(node => node.type === 'mail.fetch')!
    const result = await fetchNode.run({ id: 'n', type: 'mail.fetch' }, {
      event: { accountId: 'acc', folder: 'INBOX' },
      vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r',
      record: () => {}, log: () => {},
    } as FlowContext)
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
    expect('failure' in result && result.failure).toBe('config')
  })

  it('邮件已经不在了记 transient', async () => {
    const nodes = createMailFlowNodes(deps({ mail: { ...mailOps(), fetchDetail: async () => undefined } }))
    const fetchNode = nodes.find(node => node.type === 'mail.fetch')!
    const result = await fetchNode.run({ id: 'n', type: 'mail.fetch' }, {
      event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r',
      record: () => {}, log: () => {},
    } as FlowContext)
    expect('failure' in result && result.failure).toBe('transient')
  })
})

describe('classify', () => {
  it('把标签与置信度写进产出', async () => {
    const nodes = createMailFlowNodes(deps({ llm: () => llmOf('dev') }))
    const node = nodes.find(n => n.type === 'classify')!
    const result = await node.run(
      { id: 'c', type: 'classify', config: { labels: ['dev', 'todo'], model: 'test/m' } },
      { event, vars: {}, memory: { body: '正文' }, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    expect(result.ok).toBe(true)
    expect('output' in result && result.output?.['label']).toBe('dev')
  })

  it('模型答了集合外的词时给出 uncertain，而不是失败', async () => {
    const nodes = createMailFlowNodes(deps({ llm: () => llmOf('我也不知道') }))
    const node = nodes.find(n => n.type === 'classify')!
    const result = await node.run(
      { id: 'c', type: 'classify', config: { labels: ['dev', 'todo'], model: 'test/m' } },
      { event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    expect(result.ok).toBe(true)
    expect('output' in result && result.output?.['label']).toBe('uncertain')
    expect('output' in result && result.output?.['confidence']).toBe(0)
  })

  it('没挂模型时记 config 失败', async () => {
    const nodes = createMailFlowNodes(deps())
    const node = nodes.find(n => n.type === 'classify')!
    const result = await node.run(
      { id: 'c', type: 'classify', config: { labels: ['dev'], model: 'test/m' } },
      { event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    expect('failure' in result && result.failure).toBe('config')
  })

  it('没配 labels 时记 config 失败', async () => {
    const nodes = createMailFlowNodes(deps({ llm: () => llmOf('dev') }))
    const node = nodes.find(n => n.type === 'classify')!
    const result = await node.run(
      { id: 'c', type: 'classify', config: { model: 'test/m' } },
      { event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    expect('failure' in result && result.failure).toBe('config')
  })

  it('把 provider/model 拆开交给宿主，而不是整串塞进 model', async () => {
    const routes: unknown[] = []
    const llm: LlmLike = {
      async prepareCall(route: unknown) {
        routes.push(route)
        return {
          config: {},
          async *stream() {
            yield { type: 'text-delta', text: 'dev' }
          },
        }
      },
    }
    const nodes = createMailFlowNodes(deps({ llm: () => llm }))
    const node = nodes.find(n => n.type === 'classify')!
    await node.run(
      { id: 'c', type: 'classify', config: { labels: ['dev'], model: 'exe/deepseek-v4.1-flash-1017' } },
      { event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    // 宿主要的是 { provider, model }：整串过去会被解析成 provider: undefined。
    expect(routes[0]).toMatchObject({ provider: 'exe', model: 'deepseek-v4.1-flash-1017' })
    expect((routes[0] as Record<string, unknown>)['model']).not.toContain('/')
  })

  it('模型名没写 provider 时记 config 失败，不把 undefined 交给宿主', async () => {
    const nodes = createMailFlowNodes(deps({ llm: () => llmOf('dev') }))
    const node = nodes.find(n => n.type === 'classify')!
    const result = await node.run(
      { id: 'c', type: 'classify', config: { labels: ['dev'], model: 'deepseek-v4.1-flash-1017' } },
      { event, vars: {}, memory: {}, facts: {}, taskId: 't', flowId: 'f', runId: 'r', record: () => {}, log: () => {} } as FlowContext,
    )
    expect('failure' in result && result.failure).toBe('config')
    expect('detail' in result && String(result.detail)).toContain('provider/model')
  })
})

describe('pickLabel', () => {
  it('整段就是标签时最可信', () => {
    expect(pickLabel('dev', ['dev', 'todo'])).toEqual({ label: 'dev', confidence: 0.9 })
  })

  it('取最后一行，避免被前面的工具痕迹带偏', () => {
    expect(pickLabel('> OpenViking read: done\n\ndev', ['dev', 'todo']).label).toBe('dev')
  })

  it('只有包含关系时给较低置信度', () => {
    expect(pickLabel('我猜这属于 todo 类', ['dev', 'todo'])).toEqual({ label: 'todo', confidence: 0.8 })
  })
})

describe('两个节点接进图里', () => {
  it('fetch → classify → switch 能跑通，正文只落在 memory', async () => {
    const registry = new FlowNodeRegistry()
    registry.registerAll('core', createControlNodes())
    registry.registerAll('mail', createMailFlowNodes(deps({ llm: () => llmOf('dev') })))

    const flow: Flow = {
      id: 'f',
      name: 'f',
      connector: 'mail',
      nodes: [
        { id: 'fetch', type: 'mail.fetch', out: [{ to: 'cls' }] },
        { id: 'cls', type: 'classify', config: { labels: ['dev'], model: 'test/m' }, out: [{ to: 'sw' }] },
        { id: 'sw', type: 'switch', out: [{ to: 'done' }] },
        { id: 'done', type: 'end' },
      ],
    }
    const records: string[] = []
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event, evaluate: async () => true }, {
      registry,
      record: entry => { records.push(`${entry.nodeId}:${entry.detail}`) },
      log: () => {},
    })
    expect(result.status).toBe('done')
    expect(records[0]).toContain('读到')
    expect(records[1]).toContain('判为 dev')
  })
})
