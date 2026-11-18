// @vitest-environment jsdom
/**
 * 画布什么时候必须重建、什么时候不该动。
 *
 * 这一组是回归用例：`canvasSignature` 早先只编了节点的文字，**没编坐标**。于是自动
 * 布局把 14 个节点的新坐标写进文件、页面也把图重新读了一遍，画布却判定「数据没变」
 * 直接返回——按钮点下去一个像素都不动，看着就像坏的。
 *
 * @module @free-dsh-plugins/dsh-console/tests/flow-canvas-client
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import './support/dom-stubs.ts'
import { NODE_SIZE } from '@free-lzj/dsh-decision'
import { FlowCanvas, NODE_HEIGHT, NODE_WIDTH, READABLE_ZOOM, canvasSignature, type CanvasEdge, type CanvasNode } from '../src/client/flow-canvas.tsx'

/** 一个节点；只写用例关心的字段。 */
function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'a',
    type: 'trigger',
    label: '触发',
    group: 'trigger',
    sideEffect: false,
    x: 0,
    y: 0,
    enabled: true,
    ...over,
  }
}

/** 一条连线。 */
function edge(over: Partial<CanvasEdge> = {}): CanvasEdge {
  return { id: 'a->b#0', from: 'a', to: 'b', ...over }
}

/** 两张卡片的尺寸必须与布局算法认的尺寸一致，否则排得整齐也会压在一起。 */
describe('卡片尺寸', () => {
  it('与决策包 NODE_SIZE 一致', () => {
    expect({ width: NODE_WIDTH, height: NODE_HEIGHT }).toEqual({ ...NODE_SIZE })
  })
})

/**
 * 连线端点。
 *
 * 回归点：端点早先是 `opacity: 0` + `pointer-events: none` 的隐形小点，画布上**没有
 * 任何可以下手拉线的地方**——「拖一条线接上」这件事只能绕到右侧面板用下拉框改。
 */
describe('连线端点', () => {
  it('看得见、也摸得到', async () => {
    render(<FlowCanvas nodes={[node({ id: 'a' })]} edges={[]} />)
    // 卡片自己的样式表必须注进去：`pointer-events: all` 就在里面。
    const sheet = document.getElementById('dsh-flow-card-css')
    expect(sheet?.textContent).toContain('pointer-events: all')
    expect(sheet?.textContent).toContain('.react-flow__handle')

    const handles = [...document.querySelectorAll('.react-flow__handle')]
    expect(handles.length).toBeGreaterThan(0)
    for (const handle of handles) {
      // 不允许再用内联 opacity 把端点藏起来。
      expect((handle as HTMLElement).style.opacity).not.toBe('0')
    }
  })
})

/**
 * 框选的可读下限。
 *
 * 回归点：`fitView` 的下限早先是 `0.15`，于是 `mail-new`（11 条并列分支、模型宽
 * 3623）在 1440 宽的画布上被压到 `zoom=0.341`——卡片 96px、13px 的标题实际只有
 * 4.4px，打开编排页看到的是一张读不出字的缩略图。下限必须停在「文字还能读」处，
 * 不许为了「整张图都进视口」再退回去。
 */
describe('框选的可读下限', () => {
  it('不许低于卡片可读的缩放', () => {
    expect(READABLE_ZOOM).toBeGreaterThanOrEqual(0.6)
  })

  it('按下限缩放后，卡片和标题仍然读得出来', () => {
    // 卡片实宽：低于 180px 就只剩色块。
    expect(READABLE_ZOOM * NODE_WIDTH).toBeGreaterThanOrEqual(180)
    // 标题 13px：低于 9px 就认不出节点叫什么。
    expect(READABLE_ZOOM * 13).toBeGreaterThanOrEqual(9)
  })
})

describe('canvasSignature', () => {
  it('只有坐标变了，签名也得变——否则自动布局等于点了没反应', () => {
    const before = canvasSignature([node({ x: 60, y: 40 })], [])
    const after = canvasSignature([node({ x: 344, y: 208 })], [])
    expect(after).not.toBe(before)
  })

  it('只有分组/副作用变了也要变——卡片的配色和竖条都靠它', () => {
    const trigger = canvasSignature([node({ group: 'trigger' })], [])
    const action = canvasSignature([node({ group: 'action' })], [])
    expect(action).not.toBe(trigger)
    const plain = canvasSignature([node({ sideEffect: false })], [])
    const risky = canvasSignature([node({ sideEffect: true })], [])
    expect(risky).not.toBe(plain)
  })

  it('连线的分叉样式变了要变', () => {
    expect(canvasSignature([], [edge({ mode: 'fork' })])).not.toBe(canvasSignature([], [edge()]))
  })

  it('内容一模一样时签名一样——否则每次轮询都会把用户正在拖的节点重建掉', () => {
    const first = canvasSignature([node({ x: 60, y: 40 })], [edge()])
    const second = canvasSignature([node({ x: 60, y: 40 })], [edge()])
    expect(second).toBe(first)
  })
})

describe('试跑的点亮', () => {
  it('点亮哪条边也要进签名，否则改了结论高亮不会重画', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b', x: 400 })]
    const edges: CanvasEdge[] = [{ id: 'a->b#0', from: 'a', to: 'b' }]
    const plain = canvasSignature(nodes, edges)
    const lit = canvasSignature(nodes, edges, 'a->b#0')
    expect(lit).not.toBe(plain)
    // 同一条边再算一次还是同一个签名：不能每轮都逼画布重建。
    expect(canvasSignature(nodes, edges, 'a->b#0')).toBe(lit)
  })
})