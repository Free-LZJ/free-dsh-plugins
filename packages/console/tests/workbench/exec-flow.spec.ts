// @vitest-environment jsdom
/**
 * 实例详情里的那张图：哪一格亮、亮了什么色、点开看到什么。
 *
 * 这一层不渲染，只钉判断：同一格的多次记录、本轮与旧轮、参数展开、耗时、
 * 主图与子流程摊平之后谁排在哪。这些判断错了，画布上就是「上一轮的失败一直红着」
 * 「重试看不见」「参数是上次的」「子流程画到主图上叠成一片」这类只有真跑过才发现的错。
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/exec-flow
 */

import { describe, expect, it } from 'vitest'
import {
  definitionOf, flatIdOf, flatRunGraphOf, flowIdsOf, markIn, recordsIn, resolveParams,
  spentBetween, splitFlatId, type FlowScope,
} from '../../src/client/workbench/exec-flow.ts'
import type { Task, TaskNodeRecord } from '../../src/protocol.ts'
import type { TriageFlow, TriageNodeType } from '../../src/client/rules.tsx'

const AT = '2026-11-06T10:00:00.000Z'
const AT2 = '2026-11-06T10:00:02.000Z'

/** 主图。进度只落主图，所以绝大多数用例都用它。 */
const MAIN_SCOPE: FlowScope = { id: 'mail/new', primary: true }

/** 一条记录，默认成功。 */
function rec(over: Partial<TaskNodeRecord> & { readonly id: string }): TaskNodeRecord {
  return { kind: 'action', at: AT, ok: true, detail: '', ...over }
}

/** 一条任务；节点由调用方给。 */
function task(over: Partial<Task> & { readonly id: string; readonly nodes: readonly TaskNodeRecord[] }): Task {
  return {
    connector: 'mail',
    triggerId: 'mail:new',
    key: 'mail:acc:INBOX:1',
    title: '一封信',
    at: AT,
    updatedAt: AT,
    status: 'running',
    ...over,
  }
}

/** 一张图：trigger → step → end。 */
function flow(id: string, nodes: TriageFlow['nodes'], trigger?: string): TriageFlow {
  return { id, name: id, connector: 'mail', ...(trigger === undefined ? {} : { trigger }), nodes }
}

const TYPES: readonly TriageNodeType[] = [
  { type: 'trigger', label: '触发', group: 'trigger', sideEffect: false },
  { type: 'action', label: '动作', group: 'action', sideEffect: true },
  { type: 'end', label: '结束', group: 'end', sideEffect: false },
]

const MAIN = flow('mail/new', [
  { id: 'trigger', type: 'trigger' },
  { id: 'step', type: 'action', out: [{ to: 'end' }] },
  { id: 'end', type: 'end' },
], 'mail:new')

describe('这一格现在什么处境', () => {
  it('正在跑的压过一切', () => {
    const one = task({
      id: 't1',
      nodes: [rec({ id: 'r1', nodeId: 'step', ok: false })],
      progress: { done: [], satisfied: [], ready: ['step'], running: ['step'] },
    })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('running')
  })

  it('挂起是黄的，不是绿的——记录本身是成功的', () => {
    const one = task({
      id: 't2',
      nodes: [rec({ id: 'r1', nodeId: 'step' })],
      progress: { done: [], satisfied: [], ready: [], suspendedAt: 'step' },
    })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('suspended')
  })

  it('失败压过成功：重试前那次挂了也得看见', () => {
    const one = task({ id: 't3', nodes: [rec({ id: 'r1', nodeId: 'step', ok: false })] })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('failed')
  })

  it('跑完的是绿的，跑完且失败的看最后一条', () => {
    const one = task({
      id: 't4',
      nodes: [rec({ id: 'r1', nodeId: 'step', ok: false }), rec({ id: 'r2', nodeId: 'step', at: AT2 })],
    })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('ok')
  })

  it('没记录但引擎说做完了，也是绿的', () => {
    const one = task({
      id: 't5',
      nodes: [],
      progress: { done: ['step'], satisfied: [], ready: [] },
    })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('ok')
  })

  it('排到队首的那一格是下一步，其它是没走到', () => {
    const one = task({
      id: 't6',
      nodes: [],
      progress: { done: [], satisfied: [], ready: ['step'], running: [] },
    })
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('next')
    expect(markIn(one, MAIN_SCOPE, 'end')).toBe('idle')
  })

  it('子流程里不认进度：那边不落 progress，硬判会把格子标错', () => {
    const one = task({
      id: 't6b',
      nodes: [],
      progress: { done: ['step'], satisfied: [], ready: ['end'], running: ['step'] },
    })
    const body: FlowScope = { id: 'mail/new/body', primary: false }
    expect(markIn(one, body, 'step')).toBe('idle')
  })
})

describe('这一格跑过哪些次', () => {
  it('同一格多次记录全给，按时间升序', () => {
    const one = task({
      id: 't7',
      nodes: [
        rec({ id: 'r2', nodeId: 'step', at: AT2 }),
        rec({ id: 'r1', nodeId: 'step', at: AT }),
        rec({ id: 'other', nodeId: 'end', at: AT }),
      ],
    })
    expect(recordsIn(one, MAIN_SCOPE, 'step').map(node => node.id)).toEqual(['r1', 'r2'])
  })

  it('只看本轮：上一轮的记录不混进来', () => {
    const one = task({
      id: 't8',
      runId: 'run-2',
      nodes: [
        rec({ id: 'old', nodeId: 'step', runId: 'run-1', ok: false }),
        rec({ id: 'new', nodeId: 'step', runId: 'run-2', at: AT2 }),
      ],
    })
    expect(recordsIn(one, MAIN_SCOPE, 'step').map(node => node.id)).toEqual(['new'])
    // 上一轮的失败不会让这一次一直红着
    expect(markIn(one, MAIN_SCOPE, 'step')).toBe('ok')
  })

  it('旧记录没有 runId 时按「都算」，不至于显示成没跑过', () => {
    const one = task({ id: 't9', runId: 'run-2', nodes: [rec({ id: 'legacy', nodeId: 'step' })] })
    expect(recordsIn(one, MAIN_SCOPE, 'step').map(node => node.id)).toEqual(['legacy'])
  })

  it('同名的格子在不同图里不串台（start__0 两边都有）', () => {
    const one = task({
      id: 't9b',
      nodes: [
        rec({ id: 'main', nodeId: 'start__0', flowId: 'mail/new' }),
        rec({ id: 'body', nodeId: 'start__0', flowId: 'mail/new/body', at: AT2 }),
      ],
    })
    expect(recordsIn(one, MAIN_SCOPE, 'start__0').map(node => node.id)).toEqual(['main'])
    expect(recordsIn(one, { id: 'mail/new/body', primary: false }, 'start__0').map(node => node.id))
      .toEqual(['body'])
  })
})

describe('碰过哪几张图', () => {
  it('主图（有 trigger 的）排第一，子图其后', () => {
    const body = flow('mail/new/body', [{ id: 'trigger', type: 'trigger' }])
    const one = task({
      id: 't10',
      nodes: [
        rec({ id: 'a', nodeId: 'step', flowId: 'mail/new/body' }),
        rec({ id: 'b', nodeId: 'trigger', flowId: 'mail/new', at: AT2 }),
        rec({ id: 'c', nodeId: 'step', flowId: 'mail/new/body', at: AT2 }),
      ],
    })
    expect(flowIdsOf(one, [MAIN, body])).toEqual(['mail/new', 'mail/new/body'])
  })
})

describe('摊平成一张图', () => {
  /** 父图里那格配了 workflow，桥要接到子流程入口上。 */
  // 坐标来自流程定义里的 pos（定义页自动布局写回去的那一份）。
  const WITH_CALL = flow('mail/new', [
    { id: 'trigger', type: 'trigger', pos: { x: 60, y: 40 } },
    { id: 'call', type: 'action', config: { workflow: 'mail/new/body' }, out: [{ to: 'end' }], pos: { x: 60, y: 208 } },
    { id: 'end', type: 'end', pos: { x: 60, y: 376 } },
  ], 'mail:new')
  const BODY = flow('mail/new/body', [
    { id: 'start__0', type: 'trigger', pos: { x: 60, y: 40 } },
    { id: 'task__0', type: 'action', out: [{ to: 'end__0' }], pos: { x: 60, y: 208 } },
    { id: 'end__0', type: 'end', pos: { x: 60, y: 376 } },
  ])

  it('点亮落在对应那张图上，节点一律用扁平 id', () => {
    const one = task({
      id: 't11',
      nodes: [rec({ id: 'a', nodeId: 'step', flowId: 'mail/new' })],
      progress: { done: [], satisfied: [], ready: ['end'], running: [] },
    })
    const graph = flatRunGraphOf(one, [MAIN], TYPES)
    expect(graph?.primary).toBe('mail/new')
    expect(graph?.nodes.map(node => [node.id, node.state])).toEqual([
      ['mail/new::trigger', undefined],
      ['mail/new::step', 'ok'],
      ['mail/new::end', 'next'],
    ])
  })

  it('子流程排在主图右边，并用一条虚线从调用它的那格接过去', () => {
    const one = task({
      id: 't12',
      nodes: [
        rec({ id: 'a', nodeId: 'trigger', flowId: 'mail/new' }),
        rec({ id: 'b', nodeId: 'call', flowId: 'mail/new', at: AT }),
        rec({ id: 'c', nodeId: 'task__0', flowId: 'mail/new/body', at: AT2 }),
      ],
    })
    const graph = flatRunGraphOf(one, [WITH_CALL, BODY], TYPES)
    expect(graph).toBeDefined()
    const at = new Map((graph?.nodes ?? []).map(node => [node.id, node]))
    // 子流程被推到主图右边
    const bodyEntry = at.get('mail/new/body::start__0') as { x: number }
    const mainEnd = at.get('mail/new::end') as { x: number }
    expect(bodyEntry.x).toBeGreaterThan(mainEnd.x + 280)
    expect(at.get('mail/new/body::task__0')?.state).toBe('ok')
    const bridge = (graph?.edges ?? []).find(edge => edge.id.startsWith('bridge#'))
    expect(bridge?.from).toBe('mail/new::call')
    expect(bridge?.to).toBe('mail/new/body::start__0')
    expect(bridge?.mode).toBe('fork')
  })

  it('没跑过的子流程不铺进来：图不该被灰格子撑长', () => {
    const one = task({ id: 't13', nodes: [rec({ id: 'a', nodeId: 'trigger', flowId: 'mail/new' })] })
    const graph = flatRunGraphOf(one, [WITH_CALL, BODY], TYPES)
    expect((graph?.nodes ?? []).some(node => node.id.startsWith('mail/new/body::'))).toBe(false)
  })

  it('一张图都没有（旧记录、图被删）时是空的，不是报错', () => {
    const one = task({ id: 't14', nodes: [rec({ id: 'a', nodeId: 'step', flowId: 'gone' })] })
    expect(flatRunGraphOf(one, [MAIN], TYPES)).toBeUndefined()
  })
})

describe('扁平 id 的拆与拼', () => {
  it('图 id 里有斜杠也能拆干净', () => {
    const flat = flatIdOf('mail/new/body', 'task__0')
    expect(flat).toBe('mail/new/body::task__0')
    expect(splitFlatId(flat)).toEqual({ flowId: 'mail/new/body', nodeId: 'task__0' })
  })

  it('没有分隔符时当主图的节点处理', () => {
    expect(splitFlatId('step')).toEqual({ flowId: '', nodeId: 'step' })
  })
})

describe('选中一格之后看它的定义', () => {
  const BODY = flow('mail/new/body', [
    { id: 'task__0', type: 'action', label: '写信', config: { subject: 'Re: {subject}' } },
  ])

  it('拿得到所在图、名字与原始配置', () => {
    const got = definitionOf([BODY], flatIdOf('mail/new/body', 'task__0'))
    expect(got).toEqual({
      flowId: 'mail/new/body',
      flowName: 'mail/new/body',
      label: '写信',
      config: { subject: 'Re: {subject}' },
    })
  })

  it('图被删了就是没有，不抛错', () => {
    expect(definitionOf([BODY], 'gone::task__0')).toBeUndefined()
  })
})

describe('节点配置里的变量', () => {
  it('{变量} 换成这次的值，嵌套与数组也换', () => {
    const got = resolveParams(
      { subject: 'Re: {subject}', to: ['{owner}', 'fixed'], nested: { id: '{messageId}' } },
      { subject: 'EXEPD-1', owner: 'lzj', messageId: 'm-1' },
    )
    expect(got.actual).toEqual({ subject: 'Re: EXEPD-1', to: ['lzj', 'fixed'], nested: { id: 'm-1' } })
    expect(got.missing).toEqual([])
  })

  it('找不到的变量原样留着，并说缺哪个', () => {
    const got = resolveParams({ body: 'hi {nickname}' }, {})
    expect(got.actual).toEqual({ body: 'hi {nickname}' })
    expect(got.missing).toEqual(['nickname'])
  })

  it('没有配置就是空对象', () => {
    expect(resolveParams(undefined, undefined).actual).toEqual({})
  })
})

describe('两步之间的耗时', () => {
  it('不到一秒按毫秒，其余按秒', () => {
    expect(spentBetween(AT, '2026-11-06T10:00:00.320Z')).toBe('320ms')
    expect(spentBetween(AT, AT2)).toBe('2.0s')
  })

  it('缺一头或时间倒着就没有耗时', () => {
    expect(spentBetween(AT, undefined)).toBeUndefined()
    expect(spentBetween(AT2, AT)).toBeUndefined()
  })
})
