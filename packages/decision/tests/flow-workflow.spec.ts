import { describe, expect, it } from 'vitest'
import { createControlNodes } from '../src/flow/control.ts'
import { executeFlow, type FlowDeps } from '../src/flow/execute.ts'
import { FlowNodeRegistry } from '../src/flow/registry.ts'
import type { Flow, FlowNode, FlowNodeSpec, FlowResult, NodeRecordInput, NodeResult } from '../src/flow/types.ts'

/** 一个只会记下"自己被跑过"的假动作。 */
function marker(type: string, seen: string[]): FlowNode {
  return {
    type,
    label: type,
    group: 'action',
    async run(): Promise<NodeResult> {
      seen.push(type)
      return { ok: true, detail: type }
    },
  }
}

/** 产出正文到 memory 的假节点（正文不该进 vars）。 */
function bodyReader(): FlowNode {
  return {
    type: 'readBody',
    label: 'readBody',
    group: 'action',
    outputs: [{ key: 'body', persist: false, label: '正文' }],
    async run(): Promise<NodeResult> {
      return { ok: true, detail: '读到正文', output: { body: '正文' } }
    },
  }
}

/** 建一套跑得起来的依赖。 */
function harness(nodes: readonly FlowNode[]) {
  const registry = new FlowNodeRegistry()
  registry.registerAll('core', createControlNodes())
  registry.registerAll('test', nodes)
  const records: NodeRecordInput[] = []
  const deps: FlowDeps = {
    registry,
    record: entry => { records.push(entry) },
    log: () => {},
  }
  return { deps, records }
}

/** trigger → workflow → end。 */
function jumpTo(workflow: string, pass?: readonly string[]): Flow {
  return {
    id: 'main',
    name: 'main',
    connector: 'test',
    nodes: [
      { id: 'start', type: 'trigger', out: [{ to: 'call' }] },
      {
        id: 'call',
        type: 'workflow',
        config: { workflow, ...(pass === undefined ? {} : { pass }) },
        out: [{ to: 'fin' }],
      },
      { id: 'fin', type: 'end' },
    ] as FlowNodeSpec[],
  }
}

/** trigger → readBody → workflow → end，用来验证 memory 也能传下去。 */
function jumpAfterRead(workflow: string, pass?: readonly string[]): Flow {
  return {
    id: 'main',
    name: 'main',
    connector: 'test',
    nodes: [
      { id: 'start', type: 'trigger', out: [{ to: 'read' }] },
      { id: 'read', type: 'readBody', out: [{ to: 'call' }] },
      {
        id: 'call',
        type: 'workflow',
        config: { workflow, ...(pass === undefined ? {} : { pass }) },
        out: [{ to: 'fin' }],
      },
      { id: 'fin', type: 'end' },
    ] as FlowNodeSpec[],
  }
}

/** 从记录里找一句说明。 */
function saidAnything(result: FlowResult, records: readonly NodeRecordInput[], text: string): boolean {
  if ((result.error ?? '').includes(text)) return true
  if ((result.matched ?? '').includes(text)) return true
  return records.some(entry => (entry.detail ?? '').includes(text))
}

describe('workflow 节点：跳到另一个工作流', () => {
  it('跑完子工作流，主图继续往下走', async () => {
    const seen: string[] = []
    const { deps } = harness([marker('mark', seen)])
    const calls: string[] = []
    const result = await executeFlow(
      jumpTo('github-fix'),
      {
        taskId: 't',
        runId: 'r',
        event: {},
        runWorkflow: async (id, vars) => {
          calls.push(`${id} vars=${Object.keys(vars).sort().join(',')}`)
          return { ok: true, detail: '跑了 2 步' }
        },
      },
      deps,
    )
    expect(result.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('github-fix')
  })

  it('不写 pass 时把 event / vars / memory 全传下去', async () => {
    const { deps } = harness([bodyReader()])
    let received: Record<string, unknown> = {}
    await executeFlow(
      jumpAfterRead('wf'),
      {
        taskId: 't',
        runId: 'r',
        event: { subject: 'Hi' },
        vars: { label: 'x' },
        runWorkflow: async (_id, vars) => { received = { ...vars }; return { ok: true, detail: 'ok' } },
      },
      deps,
    )
    expect(received).toMatchObject({ subject: 'Hi', label: 'x', body: '正文' })
  })

  it('写了 pass 时只传列出的那几个', async () => {
    const { deps } = harness([bodyReader()])
    let received: Record<string, unknown> = {}
    await executeFlow(
      jumpAfterRead('wf', ['subject', 'body']),
      { taskId: 't', runId: 'r', event: { subject: 'Hi', from: 'a@b' }, runWorkflow: async (_id, vars) => { received = { ...vars }; return { ok: true, detail: 'ok' } } },
      deps,
    )
    expect(Object.keys(received).sort()).toEqual(['body', 'subject'])
    expect(received['from']).toBeUndefined()
  })

  it('子工作流失败时整轮也是失败，说明里带着原因', async () => {
    const { deps, records } = harness([])
    const result = await executeFlow(
      jumpTo('wf'),
      { taskId: 't', runId: 'r', event: {}, runWorkflow: async () => ({ ok: false, detail: '工作流不存在', failure: 'config' }) },
      deps,
    )
    expect(result.status).toBe('failed')
    expect(saidAnything(result, records, '工作流不存在')).toBe(true)
  })

  it('config 类失败不被降级成 transient（重试只会再错一次）', async () => {
    const { deps, records } = harness([])
    const result = await executeFlow(
      jumpTo('wf'),
      { taskId: 't', runId: 'r', event: {}, runWorkflow: async () => ({ ok: false, detail: '引用了一个不存在的工作流', failure: 'config' }) },
      deps,
    )
    const call = records.find(entry => entry.nodeId === 'call')
    expect(call?.failure).toBe('config')
    expect(result.status).toBe('failed')
  })

  it('没写 workflow id 时是配置错误', async () => {
    const { deps, records } = harness([])
    const flow: Flow = {
      id: 'main',
      name: 'main',
      connector: 'test',
      nodes: [
        { id: 'start', type: 'trigger', out: [{ to: 'call' }] },
        { id: 'call', type: 'workflow', config: {}, out: [{ to: 'fin' }] },
        { id: 'fin', type: 'end' },
      ],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {}, runWorkflow: async () => ({ ok: true, detail: 'ok' }) }, deps)
    expect(result.status).toBe('failed')
    expect(saidAnything(result, records, '没说要跑哪个工作流')).toBe(true)
  })

  it('执行器没提供工作流能力时明确报错', async () => {
    const { deps, records } = harness([])
    const result = await executeFlow(jumpTo('wf'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
    expect(saidAnything(result, records, '没有提供工作流能力')).toBe(true)
  })
})
