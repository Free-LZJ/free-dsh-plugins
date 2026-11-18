// @vitest-environment jsdom
/**
 * 编排视图：工具栏、画布高度、执行足迹、属性面板、试跑、连线、新建规则。
 *
 * 这一组守的都是实测撞到的坑（每条用例的注释里写了当时怎么撞上的）。
 *
 * @module @free-dsh-plugins/dsh-console/tests/flow-view-client
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
// 全量跑时机器会慢下来，1 秒的默认等待偶发超时——放宽，让红只代表真的红。
configure({ asyncUtilTimeout: 3000 })
import { afterEach, describe, expect, it } from 'vitest'
// 先补 jsdom 缺的浏览器全局，再 import 会用到 React Flow 的组件。
import './support/dom-stubs.ts'
import { FlowView } from '../src/client/flow-view.tsx'
import type { TriageFlow, TriageNodeType, TriageRun, TriageSource } from '../src/client/rules.tsx'

afterEach(cleanup)

/** 一律不翻译：这些用例断言的是中文原文。 */
const t = (key: never): string => String(key)

/** 一张事件流：触发 → 分支，两个子工作流挂上去。 */
const EVENT_FLOW: TriageFlow = {
  id: 'mail-new',
  name: 'mail-new',
  connector: 'mail',
  trigger: 'mail:new',
  nodes: [
    { id: 'trigger', type: 'trigger', out: [{ to: 'route' }], pos: { x: 60, y: 40 } },
    {
      id: 'route',
      type: 'switch',
      out: [
        { to: 'call-a', when: [{ kind: 'from', any: ['a@example.com'] }] },
        { to: 'call-b' },
      ],
      pos: { x: 60, y: 208 },
    },
    { id: 'call-a', type: 'workflow', config: { workflow: 'a' }, out: [{ to: 'end' }], pos: { x: 60, y: 376 } },
    { id: 'call-b', type: 'workflow', config: { workflow: 'b' }, out: [{ to: 'end' }], pos: { x: 396, y: 376 } },
    { id: 'end', type: 'end', pos: { x: 60, y: 544 } },
  ],
}

/** 一张子工作流：没有 trigger。 */
const SUB_FLOW: TriageFlow = {
  id: 'a',
  name: '子流程 A',
  connector: 'mail',
  nodes: [
    { id: 'a__0', type: 'markRead', config: { kind: 'markRead' }, out: [{ to: 'a__1' }] },
    { id: 'a__1', type: 'move', config: { kind: 'move', folder: '推广' } },
  ],
}

/** 这些类型够画两张图。 */
const TYPES: readonly TriageNodeType[] = [
  { type: 'trigger', label: '触发', group: 'trigger', sideEffect: false },
  { type: 'switch', label: '分支', group: 'control', sideEffect: false },
  { type: 'workflow', label: '工作流', group: 'control', sideEffect: true },
  { type: 'end', label: '结束', group: 'control', sideEffect: false },
  { type: 'markRead', label: '标记已读', group: 'action', sideEffect: true },
  { type: 'move', label: '移动', group: 'action', sideEffect: true },
]

/** 一张兜底排在有条件边前面的图：后面那条永远不会命中。 */
const CONFLICT_FLOW: TriageFlow = {
  id: 'mail-new',
  name: 'mail-new',
  connector: 'mail',
  trigger: 'mail:new',
  nodes: [
    { id: 'trigger', type: 'trigger', out: [{ to: 'route' }], pos: { x: 0, y: 0 } },
    {
      id: 'route',
      type: 'switch',
      pos: { x: 0, y: 200 },
      out: [{ to: 'catch-all' }, { to: 'call-a', when: [{ kind: 'from', any: ['a@example.com'] }] }],
    },
    { id: 'catch-all', type: 'workflow', config: { workflow: 'b' }, pos: { x: 0, y: 400 } },
    { id: 'call-a', type: 'workflow', config: { workflow: 'a' }, pos: { x: 380, y: 400 } },
  ],
}

/** 一个只答应一句话的引擎，顺便记下它被要求做了什么。 */
function engine(overrides: Partial<TriageSource> = {}) {
  const addedRules: { flowId: string; from: string; name: string; when?: readonly Readonly<Record<string, unknown>>[] }[] = []
  const source: TriageSource = {
    rules: async () => ({
      rules: [],
      source: 'file',
      path: 'C:/dsh/dsh-console/rules/events/mail-new.yml',
      dropped: [],
      connector: true,
      unassigned: 0,
    }),
    runs: async () => [],
    flow: async () => ({ flows: [EVENT_FLOW, SUB_FLOW] }),
    nodeTypes: async () => TYPES,
    saveFlowNode: async () => ({ ok: true }),
    addFlowNode: async () => ({ ok: true, nodeId: 'call-a' }),
    addFlowScaffold: async () => ({ ok: true }),
    scaffoldFlows: async () => ({ ok: true }),
    createFlow: async () => ({ ok: true, flowId: 'flow-1' }),
    removeFlowNode: async () => ({ ok: true }),
    relinkFlowEdge: async () => ({ ok: true }),
    moveFlowEdge: async () => ({ ok: true }),
    addFlowEdge: async () => ({ ok: true }),
    saveFlowEdge: async () => ({ ok: true }),
    addRule: async (input) => { addedRules.push(input); return { ok: true } },
    autoLayout: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true }),
    movePriority: async () => ({ ok: true }),
    setCondition: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    undo: async () => ({ ok: true }),
    testRun: async () => ({ ok: false as const, message: '这一页不试跑' }),
    ...overrides,
  }
  return { addedRules, source }
}

/** 画出编排视图，等第一屏读完。 */
async function draw(source: TriageSource): Promise<void> {
  render(<FlowView triage={source} t={t} />)
  await waitFor(() => { expect(screen.queryByText('正在读规则图…')).toBeNull() })
}

/** 点一个方块（jsdom 里跑不了 d3 的拖拽，只发 click）。 */
function pick(id: string): void {
  const element = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  expect(element).not.toBeNull()
  fireEvent.click(element as Element)
}

/** 一次执行记录，只填用例关心的字段。 */
function run(overrides: Partial<TriageRun> & { readonly id: string }): TriageRun {
  return {
    at: '2026-11-17T10:00:00.000Z',
    ruleId: '',
    ruleName: '',
    label: '',
    event: { from: 'x@example.com', subject: '一次执行', folder: '收件箱' },
    actions: [],
    status: 'done',
    ...overrides,
  } as TriageRun
}

describe('工具栏', () => {
  it('只在事件流上给「+ 新建规则」，子工作流不给', async () => {
    await draw(engine().source)
    expect(screen.getByRole('button', { name: '+ 新建规则' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: '+ 新建规则' })).toBeNull() })
  })

  it('「排列方式」里「紧凑」只出现一次', async () => {
    await draw(engine().source)
    const options = [...document.querySelectorAll('select option')].map((option) => option.getAttribute('value'))
    expect(options.filter((value) => value === 'compact')).toHaveLength(1)
  })

  it('一句失败提示只渲染一遍', async () => {
    await draw(engine({ autoLayout: async () => ({ ok: false, message: '这张图里没有可排的节点' }) }).source)
    fireEvent.click(screen.getByRole('button', { name: '自动布局' }))
    await waitFor(() => { expect(screen.getAllByText(/这张图里没有可排的节点/)).toHaveLength(1) })
  })
})

describe('画布高度', () => {
  it('按可用高度撑开，不写死 640', async () => {
    await draw(engine().source)
    const shell = document.querySelector('.react-flow')?.parentElement as HTMLElement | null
    expect(shell?.style.height).toBe(`${String(Math.max(320, window.innerHeight - 16))}px`)
  })
})

describe('执行足迹', () => {
  it('只认这张图跑过的那次；点另一条足迹，标记跟着换', async () => {
    const other = run({
      id: 'run-other',
      at: '2026-11-17T10:30:00.000Z',
      flows: ['a'],
      event: { from: 'x@example.com', subject: '别的图跑过的一次', folder: '收件箱' },
      nodes: [{ nodeId: 'a__0', flowId: 'a', kind: 'markRead', ok: true, detail: '标了' }],
    })
    const mine = run({
      id: 'run-mine',
      flows: ['mail-new'],
      event: { from: 'x@example.com', subject: '本图跑过的一次', folder: '收件箱' },
      nodes: [{ nodeId: 'route', flowId: 'mail-new', kind: 'switch', ok: true, detail: '命中 call-a' }],
    })
    await draw(engine({ runs: async () => [other, mine] }).source)
    const card = document.querySelector('.react-flow__node[data-id="route"] .dsh-flow-card')
    await waitFor(() => { expect(card?.getAttribute('data-state')).toBe('ok') })
    expect(screen.getByText('本图跑过的一次')).toBeTruthy()
    expect(screen.queryByText('别的图跑过的一次')).toBeNull()
  })
})

describe('属性面板', () => {
  it('点开节点就说它上次跑成什么样；孤岛也要说出来', async () => {
    const failed = run({
      id: 'run-1',
      flows: ['mail-new'],
      nodes: [{ nodeId: 'call-a', flowId: 'mail-new', kind: 'workflow', ok: false, detail: '第 2 步挂了' }],
      status: 'failed',
    })
    await draw(engine({ runs: async () => [failed] }).source)
    pick('call-a')
    await waitFor(() => { expect(screen.getByText(/上次跑：失败/)).toBeTruthy() })
    expect(screen.getByText('第 2 步挂了')).toBeTruthy()
    expect(screen.getByText('上游（谁连到它）')).toBeTruthy()
  })

  it('入口节点没有上游是正常的，不说成孤岛', async () => {
    await draw(engine().source)
    pick('trigger')
    await waitFor(() => { expect(screen.getByText(/入口：由事件进来/)).toBeTruthy() })
    expect(screen.queryByText(/没有人连到它/)).toBeNull()
  })
})

describe('试跑', () => {
  it('结论标在画布上；切到另一次执行时结论一起消失', async () => {
    const first = run({
      id: 'run-first',
      at: '2026-11-17T10:00:00.000Z',
      flows: ['mail-new'],
      event: { from: 'x@example.com', subject: '第一次', folder: '收件箱', accountId: 'acc', uid: 1 },
      nodes: [{ nodeId: 'route', flowId: 'mail-new', kind: 'switch', ok: true, detail: '命中' }],
    })
    const second = run({
      id: 'run-second',
      at: '2026-11-17T11:00:00.000Z',
      flows: ['mail-new'],
      event: { from: 'x@example.com', subject: '第二次', folder: '收件箱', accountId: 'acc', uid: 2 },
      nodes: [{ nodeId: 'route', flowId: 'mail-new', kind: 'switch', ok: true, detail: '命中' }],
    })
    await draw(engine({
      runs: async () => [second, first],
      testRun: async () => ({
        ok: true,
        result: { ruleId: 'route->call-a#0', ruleName: '分支 → call-a', actions: [], reason: '' },
      }),
    }).source)

    fireEvent.click(screen.getByRole('button', { name: '试跑这条' }))
    await waitFor(() => { expect(screen.getByText(/试跑：会走 分支 → call-a/)).toBeTruthy() })

    // 切到另一次执行：那条结论说的是上一封邮件，不能继续摆在这儿冒充答案。
    fireEvent.click(screen.getByText('第一次'))
    await waitFor(() => { expect(screen.queryByText(/试跑：会走/)).toBeNull() })
  })
})

describe('删除', () => {
  it('删节点先问一句：它不经过保存按钮，点了就是写盘', async () => {
    const removed: string[] = []
    await draw(engine({ removeFlowNode: async (nodeId) => { removed.push(nodeId); return { ok: true } } }).source)
    pick('call-a')
    fireEvent.click(await screen.findByRole('button', { name: '删除这个节点' }))
    expect(removed).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(removed).toEqual(['call-a']) })
  })

  it('点中一根线就能删掉它，也要确认一次', async () => {
    const cut: { from: string; index?: number }[] = []
    await draw(engine({
      flow: async () => ({ flows: [CONFLICT_FLOW] }),
      relinkFlowEdge: async (input) => { cut.push(input); return { ok: true } },
      moveFlowEdge: async () => ({ ok: true }),
    }).source)
    fireEvent.click(screen.getByRole('button', { name: /永远不会命中/ }))
    fireEvent.click(await screen.findByRole('button', { name: '删除这条连线' }, { timeout: 3000 }))
    expect(cut).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(cut).toEqual([{ from: 'route', index: 1 }]) }, { timeout: 3000 })
  })

  it('键盘 Delete 删除选中节点，但仍要确认；输入框里不接管', async () => {
    const removed: string[] = []
    await draw(engine({ removeFlowNode: async (nodeId) => { removed.push(nodeId); return { ok: true } } }).source)
    pick('call-a')

    const box = document.createElement('input')
    document.body.append(box)
    fireEvent.keyDown(box, { key: 'Backspace' })
    box.remove()
    expect(removed).toHaveLength(0)

    fireEvent.keyDown(window, { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(removed).toEqual(['call-a']) })
  })
})

describe('冲突提示', () => {
  it('点一句警告就选中被挡住的那个分支', async () => {
    await draw(engine({ flow: async () => ({ flows: [CONFLICT_FLOW] }) }).source)
    fireEvent.click(screen.getByRole('button', { name: /永远不会命中/ }))
    await waitFor(() => {
      expect(document.querySelector('.react-flow__node.selected')?.getAttribute('data-id')).toBe('call-a')
    })
  })
})

describe('自动布局', () => {
  it('接口带回来的坐标直接画上去，并说一句排了几个', async () => {
    await draw(engine({
      autoLayout: async () => ({ ok: true, positions: [{ id: 'route', x: 999, y: 777 }] }),
    }).source)
    const card = (): HTMLElement | null => document.querySelector('.react-flow__node[data-id="route"]')
    fireEvent.click(screen.getByRole('button', { name: '自动布局' }))
    await waitFor(() => { expect(card()?.style.transform).toContain('999px') })
    expect(screen.getByText('已重排 1 个节点')).toBeTruthy()
  })
})

describe('连线', () => {
  it('不拖线也能连：选一个还没连过的节点就建边', async () => {
    const added: { from: string; to: string; flowId?: string }[] = []
    await draw(engine({ addFlowEdge: async (input) => { added.push(input); return { ok: true } } }).source)
    pick('route')
    const add = await screen.findByLabelText('加一条出边')
    const options = [...(add as HTMLSelectElement).options].map((option) => option.value).filter((value) => value !== '')
    expect(options).toEqual(['trigger', 'end'])
    fireEvent.change(add, { target: { value: 'end' } })
    await waitFor(() => { expect(added).toEqual([{ from: 'route', to: 'end', flowId: 'mail-new' }]) })
    await waitFor(() => { expect(screen.getByText('已加一条出边')).toBeTruthy() })
  })
})

describe('改条件', () => {
  it('保存成功后出声，并让冲突提示跟着重算', async () => {
    const saved: { from: string; index: number; when?: readonly unknown[] }[] = []
    await draw(engine({
      flow: async () => ({ flows: [CONFLICT_FLOW] }),
      saveFlowEdge: async (input) => { saved.push(input); return { ok: true } },
    }).source)

    fireEvent.click(screen.getByRole('button', { name: /永远不会命中/ }))
    await waitFor(() => { expect(screen.getByText(/连线的条件/)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '保存条件' }))

    await waitFor(() => { expect(saved).toHaveLength(1) })
    expect(saved[0]?.from).toBe('route')
    // 保存成功要出声：冲突提示变在哪一处，人未必盯着。
    await waitFor(() => { expect(screen.getByText('条件已保存')).toBeTruthy() })
  })
})

describe('调用方对账', () => {
  it('选中 workflow 节点，说清它调用的工作流需要什么、这里缺什么', async () => {
    const caller: TriageFlow = {
      id: 'mail-new',
      name: 'mail-new',
      connector: 'mail',
      trigger: 'mail:new',
      nodes: [
        { id: 'trigger', type: 'trigger', out: [{ to: 'call-a' }], pos: { x: 0, y: 0 } },
        {
          id: 'call-a',
          type: 'workflow',
          // 只传 body：`subject` 是必填却没在名单里。
          config: { workflow: 'promo', pass: ['body'] },
          pos: { x: 0, y: 200 },
        },
      ],
    }
    const target: TriageFlow = {
      id: 'promo',
      name: '推广归档',
      connector: 'mail',
      nodes: [
        {
          id: 'start__0',
          type: 'start',
          config: { params: [{ name: 'subject', required: true }, { name: 'body' }] },
          out: [{ to: 'end__0' }],
        },
        { id: 'end__0', type: 'end', pos: { x: 0, y: 200 } },
      ],
    }
    await draw(engine({ flow: async () => ({ flows: [caller, target] }) }).source)
    pick('call-a')

    await waitFor(() => { expect(screen.getByText(/它调用的「推广归档」需要/)).toBeTruthy() })
    // 必填且没传：直接说跑到它会停。
    expect(screen.getByText(/subject（必填） —— 这里没传/)).toBeTruthy()
    // 非必填的不报警。
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.queryByText(/body —— 这里没传/)).toBeNull()
  })
})

describe('子工作流列表', () => {
  it('缺开始/结束的图在下拉里就标出来，不用一张张点进去看', async () => {
    const withEnds: TriageFlow = {
      id: 'done-flow',
      name: '有端点的',
      connector: 'mail',
      nodes: [
        { id: 'start', type: 'start', out: [{ to: 'end' }] },
        { id: 'end', type: 'end' },
      ],
    }
    const missing: TriageFlow = {
      id: 'bare-flow',
      name: '没端点的',
      connector: 'mail',
      nodes: [{ id: 'b__0', type: 'markRead', config: { kind: 'markRead' } }],
    }
    await draw(engine({ flow: async () => ({ flows: [EVENT_FLOW, withEnds, missing] }) }).source)
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))

    await waitFor(() => {
      const options = [...document.querySelectorAll('select option')].map((option) => option.textContent ?? '')
      expect(options.some((text) => text.includes('有端点的') && !text.includes('缺端点'))).toBe(true)
      expect(options.some((text) => text.includes('没端点的') && text.includes('（缺端点）'))).toBe(true)
    })
  })
})

describe('抬头摘要', () => {
  it('一行里说清节点数、连线数和冲突数', async () => {
    // CONFLICT_FLOW：4 节点、4 条边（trigger→route、route→catch-all、route→call-a）、1 处冲突。
    await draw(engine({ flow: async () => ({ flows: [CONFLICT_FLOW] }) }).source)
    await waitFor(() => { expect(screen.getByText(/4 个节点 · 3 条连线/)).toBeTruthy() })
    expect(screen.getByText(/1 处冲突/)).toBeTruthy()
  })

  it('没有冲突时也说一句，别让人猜', async () => {
    await draw(engine().source)
    await waitFor(() => { expect(screen.getByText(/没有冲突/)).toBeTruthy() })
  })
})

describe('新建', () => {
  it('子工作流 tab 上能直接建一张，不用先建规则', async () => {
    const created: string[] = []
    await draw(engine({ createFlow: async (name) => { created.push(name); return { ok: true, flowId: 'archive' } } }).source)
    expect(screen.queryByRole('button', { name: '+ 新建子工作流' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))
    fireEvent.click(await screen.findByRole('button', { name: '+ 新建子工作流' }))
    const box = screen.getByPlaceholderText('名字，比如「退订邮件归档」')
    expect((screen.getByRole('button', { name: '建' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box, { target: { value: '退订邮件归档' } })
    fireEvent.click(screen.getByRole('button', { name: '建' }))
    await waitFor(() => { expect(created).toEqual(['退订邮件归档']) })
  })

  it('新建规则：名字和条件都齐了才能建，条件随边一起提交', async () => {
    const { addedRules, source } = engine()
    await draw(source)
    fireEvent.click(screen.getByRole('button', { name: '+ 新建规则' }))
    const canCreate = (): boolean => (screen.getByRole('button', { name: '建' }) as HTMLButtonElement).disabled === false
    expect(canCreate()).toBe(false)

    fireEvent.change(screen.getByPlaceholderText('比如 github-do'), { target: { value: 'promo-2' } })
    expect(canCreate()).toBe(false)

    const address = screen.getByPlaceholderText('a@example.com，回车添加')
    fireEvent.change(address, { target: { value: 'x@y.z' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    await waitFor(() => { expect(canCreate()).toBe(true) })

    fireEvent.click(screen.getByRole('button', { name: '建' }))
    await waitFor(() => { expect(addedRules).toHaveLength(1) })
    expect(addedRules[0]).toEqual({
      flowId: 'mail-new',
      from: 'route',
      name: 'promo-2',
      when: [{ kind: 'from', any: ['x@y.z'] }],
    })
  })

  it('加完节点就把它选中，右侧面板立刻是它的配置', async () => {
    const addedNodes: { type: string }[] = []
    await draw(engine({
      addFlowNode: async (input) => { addedNodes.push(input); return { ok: true, nodeId: 'call-a' } },
    }).source)
    // 「新增节点」下拉没有可访问名字（title 随选中项变），按选项找它。
    const addSelect = [...document.querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'markRead'),
    )
    fireEvent.change(addSelect as HTMLSelectElement, { target: { value: 'markRead' } })
    await waitFor(() => { expect(addedNodes).toHaveLength(1) })
    await waitFor(() => { expect(screen.getByText(/workflow · control/)).toBeTruthy() })
  })
})

describe('Esc 与键盘', () => {
  it('Esc 退出选中，画布和面板一起清空', async () => {
    await draw(engine().source)
    pick('call-a')
    await waitFor(() => { expect(screen.getByText('上游（谁连到它）')).toBeTruthy() })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByText('上游（谁连到它）')).toBeNull() })
  })
})

describe('入参表单', () => {
  it('入参是一行一个变量的表单，不是 JSON 框', async () => {
    const saved: Record<string, unknown>[] = []
    const withStart: TriageFlow = {
      id: 'security',
      name: '已知账号与安全发件人',
      connector: 'mail',
      nodes: [
        { id: 'start__0', type: 'start', config: { params: ['subject'] }, out: [{ to: 'end__0' }], pos: { x: 0, y: 0 } },
        { id: 'end__0', type: 'end', pos: { x: 0, y: 200 } },
      ],
    }
    const types: readonly TriageNodeType[] = [
      ...TYPES,
      {
        type: 'start',
        label: '开始',
        group: 'control',
        sideEffect: false,
        config: { params: { type: 'names', label: '入参', hint: '调用方按名字传' } },
      },
    ]
    await draw(engine({
      flow: async () => ({ flows: [withStart] }),
      nodeTypes: async () => types,
      saveFlowNode: async (patch) => { saved.push(patch as unknown as Record<string, unknown>); return { ok: true } },
    }).source)

    // 子工作流不在默认那一栏里：先切过去。
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))
    await waitFor(() => { expect(document.querySelector('.react-flow__node[data-id="start__0"]')).not.toBeNull() })
    pick('start__0')

    // 已有的 `subject` 摆成一行可编辑的输入框，而不是躺在 JSON 文本里。
    await waitFor(() => { expect(screen.getByDisplayValue('subject')).toBeTruthy() })
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '保存这个节点' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '保存这个节点' }))
    await waitFor(() => { expect(saved).toHaveLength(1) })
    expect((saved[0] as { config?: { params?: unknown } }).config?.params).toEqual([
      { name: 'subject', required: true },
    ])
  })
})

describe('冲突展开', () => {
  it('冲突超过 4 条时「还有 N 处」能点开看全部，也收得回去', async () => {
    // 五条同样条件的出边两两重叠：C(5,2)=10 处冲突。
    const crowded: TriageFlow = {
      id: 'mail-new',
      name: 'mail-new',
      connector: 'mail',
      trigger: 'mail:new',
      nodes: [
        { id: 'trigger', type: 'trigger', out: [{ to: 'route' }], pos: { x: 0, y: 0 } },
        {
          id: 'route',
          type: 'switch',
          pos: { x: 0, y: 200 },
          out: ['a', 'b', 'c', 'd', 'e'].map((name) => ({
            to: `call-${name}`,
            when: [{ kind: 'from', any: ['x@example.com'] }],
          })),
        },
        ...['a', 'b', 'c', 'd', 'e'].map((name, index) => ({
          id: `call-${name}`,
          type: 'workflow' as const,
          config: { workflow: name },
          pos: { x: index * 300, y: 400 },
        })),
      ],
    }
    await draw(engine({ flow: async () => ({ flows: [crowded] }) }).source)

    expect(screen.getAllByRole('button', { name: /同时命中/ })).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /还有 6 处/ }))
    await waitFor(() => { expect(screen.getAllByRole('button', { name: /同时命中/ })).toHaveLength(10) })
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    await waitFor(() => { expect(screen.getAllByRole('button', { name: /同时命中/ })).toHaveLength(4) })
  })
})
describe('读得懂（中文名与简介）', () => {
  /** 一张带说明的子工作流：`name` 是人话，`description` 是它到底干什么。 */
  const PROMO: TriageFlow = {
    id: 'promo',
    name: '带退订头的群发',
    description: '标为已读并挪进「推广」文件夹，不提醒',
    connector: 'mail',
    nodes: [
      { id: 'promo__0', type: 'markRead', config: { kind: 'markRead' }, out: [{ to: 'promo__1' }] },
      { id: 'promo__1', type: 'move', config: { kind: 'move', folder: '推广' } },
    ],
  }

  /** 事件流里那个 workflow 节点没有 label，只有 config.workflow = promo。 */
  const CALLER: TriageFlow = {
    id: 'mail-new',
    name: 'mail-new',
    connector: 'mail',
    trigger: 'mail:new',
    nodes: [
      { id: 'trigger', type: 'trigger', out: [{ to: 'route' }], pos: { x: 0, y: 0 } },
      {
        id: 'route',
        type: 'switch',
        pos: { x: 0, y: 200 },
        out: [{ to: 'call-promo' }, { to: 'call-other' }],
      },
      { id: 'call-promo', type: 'workflow', config: { workflow: 'promo' }, out: [{ to: 'end' }], pos: { x: 0, y: 400 } },
      { id: 'call-other', type: 'workflow', config: { workflow: 'nope' }, out: [{ to: 'end' }], pos: { x: 380, y: 400 } },
      { id: 'end', type: 'end', pos: { x: 0, y: 560 } },
    ],
  }

  const source = (overrides: Partial<TriageSource> = {}): TriageSource => engine({
    flow: async () => ({ flows: [CALLER, PROMO] }),
    ...overrides,
  }).source

  it('画布上写子工作流的中文名，不写 workflow 这个词', async () => {
    await draw(source())
    const node = document.querySelector('.react-flow__node[data-id="call-promo"]')
    expect(node?.textContent).toContain('带退订头的群发')
    expect(node?.textContent).not.toBe('workflow')
  })

  it('节点的第二行是该子工作流的简介，不是它的内部第一个动作', async () => {
    await draw(source())
    const node = document.querySelector('.react-flow__node[data-id="call-promo"]')
    expect(node?.textContent).toContain('标为已读并挪进「推广」文件夹')
  })

  it('「去向」的每个选项都是人话：中文名 + 编号，一眼看出走到哪', async () => {
    await draw(source())
    pick('route')
    await waitFor(() => { expect(screen.getByText(/分支（从上往下判定/)).toBeTruthy() })
    const labels = [...document.querySelectorAll('select option')]
      .map((option) => option.textContent ?? '')
      .filter((text) => text.includes('call-promo') || text.includes('call-other'))
    expect(labels).toContain('带退订头的群发（call-promo）')
    // 查不到对应子工作流时退化成编号，不能变成空白。
    expect(labels).toContain('→ nope（call-other）')
  })

  it('分支可以往上挪：顺序就是判定优先级，挪完要写盘', async () => {
    const moved: { from: string; index: number; direction: string }[] = []
    await draw(source({
      moveFlowEdge: async (input) => { moved.push({ from: input.from, index: input.index, direction: input.direction }); return { ok: true } },
    }))
    pick('route')
    // 按钮上写的是箭头，title 只是悬停提示，无障碍名取的是箭头。
    // route 有两条出边：↑ 两个，第二个才可点。
    const ups = await screen.findAllByRole('button', { name: '↑' })
    expect(ups).toHaveLength(2)
    fireEvent.click(ups[1] as Element)
    await waitFor(() => { expect(moved).toHaveLength(1) })
    expect(moved[0]).toMatchObject({ from: 'route', index: 1, direction: 'up' })
  })
})
describe('一次补齐端点', () => {
  it('缺端点的子工作流在抬头给出张数，点一下全补（逐张备份由引擎负责）', async () => {
    const calls: number[] = []
    await draw(engine({ scaffoldFlows: async () => { calls.push(1); return { ok: true, message: '已补齐 1 张' } } }).source)
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))
    const button = await screen.findByRole('button', { name: /全部补齐（1 张缺端点）/ })
    fireEvent.click(button)
    await waitFor(() => { expect(calls).toHaveLength(1) })
    // 补完之后按钮就该消失：没有缺的了。
    await waitFor(() => { expect(screen.getByText('已补齐 1 张')).toBeTruthy() })
  })
  it('宿主没重启、不认批量动作时，退化成逐张补', async () => {
    const single: string[] = []
    await draw(engine({
      scaffoldFlows: async () => ({ ok: false, message: 'flowId is required' }),
      addFlowScaffold: async (flowId) => { single.push(flowId); return { ok: true } },
    }).source)
    fireEvent.click(screen.getByRole('button', { name: /子工作流/ }))
    fireEvent.click(await screen.findByRole('button', { name: /全部补齐（1 张缺端点）/ }))
    await waitFor(() => { expect(single).toEqual(['a']) })
    expect(await screen.findByText(/走的是逐张补/)).toBeTruthy()
  })
})
