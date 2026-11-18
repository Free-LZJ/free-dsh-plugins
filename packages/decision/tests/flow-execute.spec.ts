import { describe, expect, it } from 'vitest'
import { createControlNodes } from '../src/flow/control.ts'
import { executeFlow, type FlowDeps } from '../src/flow/execute.ts'
import { FlowNodeRegistry } from '../src/flow/registry.ts'
import type {
  Flow, FlowContext, FlowNode, FlowNodeSpec, FlowProgress, NodeRecordInput, NodeResult,
} from '../src/flow/types.ts'

/** 一个可编程的假动作：记录调用、按配置返回。 */
function fakeNode(type: string, behaviour: (spec: FlowNodeSpec, context: FlowContext) => Promise<NodeResult>): FlowNode {
  return { type, label: type, group: 'action', run: behaviour }
}

/** 建一套跑得起来的依赖。 */
function harness(nodes: readonly FlowNode[]) {
  const registry = new FlowNodeRegistry()
  registry.registerAll('core', createControlNodes())
  registry.registerAll('test', nodes)
  const records: NodeRecordInput[] = []
  const saved: FlowProgress[] = []
  const deps: FlowDeps = {
    registry,
    record: entry => { records.push(entry) },
    log: () => {},
    saveProgress: progress => { saved.push(progress) },
  }
  return { deps, records, saved }
}

/** 一张只有串行节点的图。 */
function chain(...types: string[]): Flow {
  const nodes: FlowNodeSpec[] = types.map((type, index) => ({
    id: `n${String(index)}`,
    type,
    ...(index === types.length - 1 ? {} : { out: [{ to: `n${String(index + 1)}` }] }),
  }))
  return { id: 'f', name: 'f', connector: 'test', nodes }
}

describe('开始 / 结束：入参出参的软校验', () => {
  /** 一张 `start → a → end` 的图，两端都带声明。 */
  function ioFlow(startConfig?: Record<string, unknown>, endConfig?: Record<string, unknown>): Flow {
    return {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        { id: 's', type: 'start', ...(startConfig === undefined ? {} : { config: startConfig }), out: [{ to: 'a' }] },
        { id: 'a', type: 'echo', out: [{ to: 'e' }] },
        { id: 'e', type: 'end', ...(endConfig === undefined ? {} : { config: endConfig }) },
      ],
    }
  }

  const echo = fakeNode('echo', async () => ({ ok: true, detail: '做了点事' }))

  it('必填入参没收到，这一步明确失败并列出缺了谁', async () => {
    const { deps, records } = harness([echo])
    await executeFlow(ioFlow({ params: [{ name: 'subject', required: true }, { name: 'body' }] }), {
      taskId: 't', runId: 'r', event: {}, vars: { body: '正文' },
    }, deps)
    const start = records.find(record => record.nodeId === 's')
    expect(start?.ok).toBe(false)
    expect(start?.failure).toBe('config')
    expect(start?.detail).toContain('subject')
    // 缺必填就停在这一步（带着 config 失败），而不是让后面的动作拿着空值乱跑。
    expect(records.some(record => record.nodeId === 'a')).toBe(false)
  })

  it('入参齐了就说收到了几个', async () => {
    const { deps, records } = harness([echo])
    await executeFlow(ioFlow({ params: [{ name: 'subject', required: true }] }), {
      taskId: 't', runId: 'r', event: { subject: '标题' },
    }, deps)
    const start = records.find(record => record.nodeId === 's')
    expect(start?.ok).toBe(true)
    expect(start?.detail).toContain('1/1')
  })

  it('出参缺了如实说，但不判失败——早期分支结束本来就没有这些变量', async () => {
    const { deps, records } = harness([echo])
    await executeFlow(ioFlow(undefined, { outputs: ['body', 'subject'] }), {
      taskId: 't', runId: 'r', event: {}, vars: { subject: '标题' },
    }, deps)
    const end = records.find(record => record.nodeId === 'e')
    expect(end?.ok).toBe(true)
    expect(end?.detail).toContain('没有出参：body')
  })
})

describe('executeFlow：顺序与上下文', () => {
  it('按出边顺序跑完，产出进 vars', async () => {
    const { deps, records } = harness([
      fakeNode('a', async () => ({ ok: true, detail: 'a', output: { x: 1 } })),
      fakeNode('b', async (_spec, context) => ({ ok: true, detail: `b 看到 ${String(context.vars['x'])}` })),
    ])
    const result = await executeFlow(chain('a', 'b'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('done')
    expect(records.map(r => r.nodeId)).toEqual(['n0', 'n1'])
    expect(records[1]?.detail).toBe('b 看到 1')
  })

  it('每一格都带着「哪张图」——跨图执行靠它分归属', async () => {
    // 一次事件会跨图（事件流调子工作流），而 `trigger` / `route` / `end` 这些 id 到处
    // 都有：只有 nodeId 时，页面分不清这条记录属于哪张图，画布也只能整片标或整片不标。
    const { deps, records } = harness([
      fakeNode('a', async () => ({ ok: true, detail: 'a' })),
    ])
    await executeFlow(chain('a'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(records[0]?.flowId).toBe('f')
  })

  it('persist: false 的产出进 memory，不进 vars', async () => {
    const writer: FlowNode = {
      type: 'fetch',
      label: 'fetch',
      group: 'action',
      outputs: [{ key: 'body', persist: false }],
      run: async () => ({ ok: true, detail: '读到了', output: { body: '很长的正文' } }),
    }
    const reader = fakeNode('read', async (_spec, context) => ({
      ok: true,
      detail: `vars=${JSON.stringify(context.vars)} memory=${JSON.stringify(context.memory)}`,
    }))
    const { deps, records } = harness([writer, reader])
    await executeFlow(chain('fetch', 'read'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(records[1]?.detail).toContain('memory={"body":"很长的正文"}')
    expect(records[1]?.detail).toContain('vars={}')
  })

  it('label 产出同时写进 facts', async () => {
    const classify = fakeNode('classify', async () => ({
      ok: true,
      detail: '判为 dev',
      output: { label: 'dev', confidence: 0.9 },
    }))
    let seen: FlowContext | undefined
    const peek = fakeNode('peek', async (_spec, context) => {
      seen = context
      return { ok: true, detail: 'ok' }
    })
    const { deps } = harness([classify, peek])
    await executeFlow(chain('classify', 'peek'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(seen?.facts.label).toBe('dev')
    expect(seen?.facts.confidence).toBe(0.9)
  })
})

describe('executeFlow：分支', () => {
  /** switch → 两条支路。 */
  function fork(): Flow {
    return {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        {
          id: 'sw',
          type: 'switch',
          out: [
            { to: 'yes', when: [{ kind: 'from' }] },
            { to: 'no' },
          ],
        },
        { id: 'yes', type: 'mark-yes' },
        { id: 'no', type: 'mark-no' },
      ],
    }
  }

  it('条件成立走第一条，另一条不跑', async () => {
    const registry = new FlowNodeRegistry()
    registry.registerAll('core', createControlNodes())
    registry.registerAll('test', [
      fakeNode('mark-yes', async () => ({ ok: true, detail: 'yes' })),
      fakeNode('mark-no', async () => ({ ok: true, detail: 'no' })),
    ])
    const records: NodeRecordInput[] = []
    const result = await executeFlow(fork(), { taskId: 't', runId: 'r', event: {}, evaluate: async () => true }, {
      registry, record: e => { records.push(e) }, log: () => {},
    })
    expect(result.status).toBe('done')
    expect(records.map(r => r.nodeId)).toEqual(['sw', 'yes'])
  })

  it('条件不成立走兜底边', async () => {
    const registry = new FlowNodeRegistry()
    registry.registerAll('core', createControlNodes())
    registry.registerAll('test', [
      fakeNode('mark-yes', async () => ({ ok: true, detail: 'yes' })),
      fakeNode('mark-no', async () => ({ ok: true, detail: 'no' })),
    ])
    const records: NodeRecordInput[] = []
    await executeFlow(fork(), { taskId: 't', runId: 'r', event: {}, evaluate: async () => false }, {
      registry, record: e => { records.push(e) }, log: () => {},
    })
    expect(records.map(r => r.nodeId)).toEqual(['sw', 'no'])
  })
})

describe('executeFlow：并行与汇合', () => {
  it('两个 fork 分支同批跑，汇合等都完成才执行', async () => {
    const order: string[] = []
    const registry = new FlowNodeRegistry()
    registry.registerAll('core', createControlNodes())
    registry.registerAll('test', [
      fakeNode('slow', async () => {
        await new Promise(resolve => { setTimeout(resolve, 20) })
        order.push('slow')
        return { ok: true, detail: 'slow' }
      }),
      fakeNode('fast', async () => {
        order.push('fast')
        return { ok: true, detail: 'fast' }
      }),
      fakeNode('join-work', async () => {
        order.push('join')
        return { ok: true, detail: 'join' }
      }),
    ])
    const flow: Flow = {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        { id: 'p', type: 'parallel', out: [{ to: 'slow', mode: 'fork' }, { to: 'fast', mode: 'fork' }] },
        { id: 'slow', type: 'slow', out: [{ to: 'j' }] },
        { id: 'fast', type: 'fast', out: [{ to: 'j' }] },
        { id: 'j', type: 'join', out: [{ to: 'done' }] },
        { id: 'done', type: 'join-work' },
      ],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, {
      registry, record: () => {}, log: () => {},
    })
    expect(result.status).toBe('done')
    // fast 比 slow 先完成（并发），但 join 排在两者之后。
    expect(order).toEqual(['fast', 'slow', 'join'])
  })
})

describe('executeFlow：循环', () => {
  it('按 times 跑满轮数', async () => {
    let calls = 0
    const { deps } = harness([
      fakeNode('bump', async () => {
        calls += 1
        return { ok: true, detail: `第 ${String(calls)} 次` }
      }),
    ])
    const flow: Flow = {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        {
          id: 'lo',
          type: 'loop',
          config: { times: 3 },
          body: { nodes: [{ id: 'inner', type: 'bump' }] },
        },
      ],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('done')
    expect(calls).toBe(3)
  })

  it('until 成立时提前停', async () => {
    let calls = 0
    const { deps } = harness([
      fakeNode('bump', async () => {
        calls += 1
        return { ok: true, detail: 'bump' }
      }),
    ])
    const flow: Flow = {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        {
          id: 'lo',
          type: 'loop',
          config: { times: 10, until: [{ kind: 'from' }] },
          body: { nodes: [{ id: 'inner', type: 'bump' }] },
        },
      ],
    }
    // 第 2 轮结束后条件成立。
    const result = await executeFlow(flow, {
      taskId: 't', runId: 'r', event: {},
      evaluate: async () => calls >= 2,
    }, deps)
    expect(result.status).toBe('done')
    expect(calls).toBe(2)
  })

  it('没有循环体时记 config 失败', async () => {
    const { deps } = harness([])
    const flow: Flow = {
      id: 'f', name: 'f', connector: 'test',
      nodes: [{ id: 'lo', type: 'loop', config: { times: 2 } }],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
  })

  it('既没 times 也没 until 时记 config 失败', async () => {
    const { deps } = harness([fakeNode('bump', async () => ({ ok: true, detail: 'x' }))])
    const flow: Flow = {
      id: 'f', name: 'f', connector: 'test',
      nodes: [{ id: 'lo', type: 'loop', body: { nodes: [{ id: 'inner', type: 'bump' }] } }],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
  })

  it('循环体里失败会把整轮判为失败', async () => {
    const { deps } = harness([
      fakeNode('boom', async () => ({ ok: false, detail: '炸了', failure: 'config' })),
    ])
    const flow: Flow = {
      id: 'f', name: 'f', connector: 'test',
      nodes: [{ id: 'lo', type: 'loop', config: { times: 3 }, body: { nodes: [{ id: 'inner', type: 'boom' }] } }],
    }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
  })
})

describe('executeFlow：失败', () => {
  it('transient 失败仍走后续节点，整轮记 partial', async () => {
    const { deps, records } = harness([
      fakeNode('boom', async () => ({ ok: false, detail: '炸了', failure: 'transient' })),
      fakeNode('after', async () => ({ ok: true, detail: '照跑' })),
    ])
    const result = await executeFlow(chain('boom', 'after'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('partial')
    expect(records.map(r => r.nodeId)).toEqual(['n0', 'n1'])
    expect(records[0]?.failure).toBe('transient')
  })

  it('config 失败中止整轮，后续节点不跑', async () => {
    const { deps, records } = harness([
      fakeNode('bad', async () => ({ ok: false, detail: '配置错了', failure: 'config' })),
      fakeNode('after', async () => ({ ok: true, detail: '不该跑' })),
    ])
    const result = await executeFlow(chain('bad', 'after'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
    expect(records.map(r => r.nodeId)).toEqual(['n0'])
  })

  it('未注册的节点类型记 config 失败', async () => {
    const { deps, records } = harness([])
    const result = await executeFlow(chain('nope'), { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('failed')
    expect(records[0]?.detail).toContain('没有注册')
  })

  it('禁用的节点被跳过，但它的出边照走', async () => {
    const { deps, records } = harness([
      fakeNode('a', async () => ({ ok: true, detail: 'a' })),
      fakeNode('b', async () => ({ ok: true, detail: 'b' })),
    ])
    const flow = chain('a', 'b')
    const disabled: Flow = {
      ...flow,
      nodes: flow.nodes.map(node => node.id === 'n0' ? { ...node, enabled: false } : node),
    }
    const result = await executeFlow(disabled, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('done')
    expect(records.find(r => r.nodeId === 'n0')?.detail).toContain('禁用')
    expect(records.some(r => r.nodeId === 'n1')).toBe(true)
  })
})

describe('executeFlow：挂起与续跑', () => {
  const waiter: FlowNode = {
    type: 'wait',
    label: '等待',
    group: 'action',
    run: async (_spec, context) => {
      if (context.signal !== undefined) {
        return { ok: true, detail: `拿到了 ${String(context.signal['answer'])}`, output: { answer: context.signal['answer'] } }
      }
      return { ok: true, suspend: { on: 'event', detail: '等人回话' } }
    },
  }

  it('挂起后返回 suspended，进度里记下停在哪', async () => {
    const { deps, saved } = harness([waiter])
    const flow: Flow = { id: 'f', name: 'f', connector: 'test', nodes: [{ id: 'w', type: 'wait' }] }
    const result = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(result.status).toBe('suspended')
    expect(result.progress.suspendedAt).toBe('w')
    expect(result.progress.done).toEqual([])
    expect(saved.length).toBeGreaterThan(0)
  })

  it('带信号恢复后从挂起点继续，已完成节点不重跑', async () => {
    const calls: string[] = []
    const first: FlowNode = fakeNode('first', async () => {
      calls.push('first')
      return { ok: true, detail: 'first' }
    })
    const { deps } = harness([first, waiter])
    const flow: Flow = {
      id: 'f',
      name: 'f',
      connector: 'test',
      nodes: [
        { id: 'a', type: 'first', out: [{ to: 'w' }] },
        { id: 'w', type: 'wait', out: [{ to: 'z' }] },
        { id: 'z', type: 'first' },
      ],
    }
    const paused = await executeFlow(flow, { taskId: 't', runId: 'r', event: {} }, deps)
    expect(paused.status).toBe('suspended')

    const resumed = await executeFlow(
      flow,
      { taskId: 't', runId: 'r', event: {}, progress: paused.progress, signal: { answer: 42 } },
      deps,
    )
    expect(resumed.status).toBe('done')
    // 第一轮跑过 a；恢复时只跑 w 与 z，a 不再执行。
    expect(calls).toEqual(['first', 'first'])
    expect(resumed.progress.done).toEqual(['a', 'w', 'z'])
  })

  it('挂起次数超上限判为死循环', async () => {
    const always: FlowNode = {
      type: 'always-suspend',
      label: 'x',
      group: 'action',
      run: async () => ({ ok: true, suspend: { on: 'event', detail: '永远等' } }),
    }
    const { deps } = harness([always])
    const flow: Flow = { id: 'f', name: 'f', connector: 'test', nodes: [{ id: 'w', type: 'always-suspend' }] }
    const result = await executeFlow(
      flow,
      { taskId: 't', runId: 'r', event: {}, progress: { done: [], satisfied: [], ready: ['w'], suspendedAt: 'w', suspends: 50 } },
      deps,
    )
    expect(result.status).toBe('failed')
  })
})
