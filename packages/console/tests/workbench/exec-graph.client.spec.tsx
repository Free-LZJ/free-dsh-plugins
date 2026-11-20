// @vitest-environment jsdom
/**
 * 实例详情里的流程图：从定义画出来，按这次执行点亮，节点点开说话。
 *
 * 这一组必须真的把画布渲染出来（React Flow + 画布样式），所以带 DOM 桩；纯判断
 * 在 `exec-flow.spec.ts` 里测。
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/exec-graph
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import './../support/dom-stubs.ts'
import { zh, type Translate } from '../../src/client/locales.ts'
import { BoardView, buildTasks, type BoardFace } from '../../src/client/workbench/board.tsx'
import type { TriageFlow, TriageNodeType } from '../../src/client/rules.tsx'
import type { Task, TaskNodeRecord } from '../../src/protocol.ts'

const t: Translate = ((key: string, params?: Record<string, string | number>) => {
  const template = (zh as unknown as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}) as Translate

/** 一张图：触发 → 发信 → 结束。 */
const FLOW: TriageFlow = {
  id: 'mail/new',
  name: '新邮件',
  connector: 'mail',
  trigger: 'mail:new',
  nodes: [
    { id: 'trigger', type: 'trigger' },
    { id: 'step', type: 'send', config: { subject: 'Re: {subject}' }, out: [{ to: 'end' }] },
    { id: 'end', type: 'end' },
  ],
}

const TYPES: readonly TriageNodeType[] = [
  { type: 'trigger', label: '触发', group: 'trigger', sideEffect: false },
  { type: 'send', label: '发信', group: 'action', sideEffect: true },
  { type: 'end', label: '结束', group: 'end', sideEffect: false },
]

/** 一条记录。 */
function rec(over: Partial<TaskNodeRecord> & { readonly id: string }): TaskNodeRecord {
  return { kind: 'action', at: '2026-11-06T10:00:00.000Z', ok: true, detail: '', ...over }
}

/** 这条任务：触发跑过、发信跑过、结束排着队。 */
function task(): Task {
  return {
    id: 't1',
    connector: 'mail',
    triggerId: 'mail:new',
    key: 'mail:acc:INBOX:1',
    title: 'EXEPD-1 崩了',
    at: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:02.000Z',
    status: 'running',
    runId: 'run-1',
    vars: { subject: 'EXEPD-1 崩了' },
    nodes: [
      rec({ id: 'n1', kind: 'trigger', nodeId: 'trigger', flowId: 'mail/new', runId: 'run-1', detail: '收到' }),
      rec({
        id: 'n2', kind: 'send', nodeId: 'step', flowId: 'mail/new', runId: 'run-1',
        at: '2026-11-06T10:00:02.000Z', detail: '发出去了', data: { status: 200 },
      }),
    ],
    progress: { done: ['trigger', 'step'], satisfied: [], ready: ['end'], running: [] },
  }
}

/** 一个只管回答渲染所问的 face。 */
function face(): BoardFace {
  return {
    tasks: () => [],
    running: () => [],
    rhythm: () => 'immediate',
    setRhythm: () => {},
    rhythmMs: () => 0,
    undo: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    openRules: () => {},
    flow: async () => ({ flows: [FLOW], nodeTypes: TYPES }),
    canJumpTo: () => false,
    jumpTo: () => ({ ok: false }),
  }
}

afterEach(() => { cleanup() })

/** 画出看板，点开那张卡。 */
async function openDetail(): Promise<void> {
  const one = task()
  const now = Date.now()
  render(
    <BoardView
      face={face()}
      t={t}
      data={{ tasks: buildTasks([one], new Set(), 60_000, now, t), loaded: true, error: '' }}
    />,
  )
  fireEvent.click(screen.getByLabelText('EXEPD-1 崩了'))
  await waitFor(() => { expect(document.querySelector('.dshc-flow-box')).not.toBeNull() })
}

/** 画布上的节点 id 是扁平 id：图::节点。 */
function flat(nodeId: string): string {
  return `mail/new::${nodeId}`
}

/** 一格卡片的处境。 */
function markOfNode(id: string): string | null | undefined {
  return document.querySelector(`.react-flow__node[data-id="${id}"] .dsh-flow-card`)?.getAttribute('data-state')
}

/** 等画布把节点摆出来。 */
async function waitNode(id: string): Promise<void> {
  await waitFor(() => { expect(document.querySelector(`.react-flow__node[data-id="${id}"]`)).not.toBeNull() })
}

describe('实例详情里的流程图', () => {
  it('按定义画出来，跑过的亮绿的，排着队的说是下一步', async () => {
    await openDetail()
    await waitNode(flat('step'))
    expect(markOfNode(flat('trigger'))).toBe('ok')
    expect(markOfNode(flat('step'))).toBe('ok')
    expect(markOfNode(flat('end'))).toBe('next')
  })

  it('点一格看到实际参数和产出', async () => {
    await openDetail()
    await waitNode(flat('step'))
    fireEvent.click(document.querySelector(`.react-flow__node[data-id="${flat('step')}"]`) as Element)
    await waitFor(() => { expect(document.querySelector('.dshc-flow-node-pane .dshc-flow-node-card')).not.toBeNull() })
    const card = document.querySelector('.dshc-flow-node-card') as HTMLElement
    // 参数里的 {subject} 已展开成本次执行的值
    expect(card.textContent).toContain('Re: EXEPD-1 崩了')
    // 这一格的产出落在这里
    expect(card.textContent).toContain('"status": 200')
    expect(card.textContent).toContain('发出去了')
  })

  it('详情是画布右边那一栏，不是掉在下边的卡片', async () => {
    await openDetail()
    await waitNode(flat('step'))
    const pane = document.querySelector('.dshc-flow-node-pane') as HTMLElement
    // 没选中时那一栏给提示，不是空的
    expect(pane).not.toBeNull()
    expect(pane.textContent).not.toBe('')
  })

  it('全屏铺满整个视口，Esc 退出而且不把详情弹窗一起关掉', async () => {
    await openDetail()
    fireEvent.click(screen.getByText('全屏'))
    await waitFor(() => { expect(document.querySelector('.dshc-flow-full')).not.toBeNull() })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('.dshc-flow-full')).toBeNull() })
    // 弹窗还在：Esc 只该退出全屏
    expect(document.querySelector('.dshc-flow-box')).not.toBeNull()
  })
})
