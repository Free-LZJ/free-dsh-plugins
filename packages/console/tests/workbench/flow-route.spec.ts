// @vitest-environment jsdom
/**
 * 连线的走法：横平竖直、扇出共主干、汇入共汇流、不压卡片。
 *
 * 这些断言看着细，但每一条都对应一个能看见的毛病：线段斜了就糊、扇出各走各的就散、
 * 压到卡片上的线就把那格的名字盖住了。画布上肉眼能发现，可肉眼不会每次都去看，
 * 所以钉在这里。
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/flow-route
 */

import { describe, expect, it } from 'vitest'
import { NODE_HEIGHT, NODE_WIDTH } from '../../src/client/flow-canvas.tsx'
import {
  pathOf, ROUTE_SIZE, routeEdges, type RoutePoint,
} from '../../src/client/flow-route.ts'
import type { CanvasEdge, CanvasNode } from '../../src/client/flow-canvas.tsx'

/** 一张卡片。只填算路用得上的字段。 */
function node(id: string, x: number, y: number): CanvasNode {
  return { id, type: 'action', label: id, group: 'action', sideEffect: true, enabled: true, x, y }
}

function edge(from: string, to: string): CanvasEdge {
  return { id: `${from}->${to}`, from, to }
}

interface Box {
  readonly l: number
  readonly t: number
  readonly r: number
  readonly b: number
}

function boxOf(item: CanvasNode): Box {
  return { l: item.x, t: item.y, r: item.x + NODE_WIDTH, b: item.y + NODE_HEIGHT }
}

/** 折线拆成线段。 */
function segments(points: readonly RoutePoint[]): { x1: number; y1: number; x2: number; y2: number }[] {
  const out: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as RoutePoint
    const b = points[index] as RoutePoint
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  return out
}

/** 一段线有没有穿进框里（端点贴边不算）。 */
function hits(seg: { x1: number; y1: number; x2: number; y2: number }, box: Box): boolean {
  const l = Math.min(seg.x1, seg.x2)
  const r = Math.max(seg.x1, seg.x2)
  const t = Math.min(seg.y1, seg.y2)
  const b = Math.max(seg.y1, seg.y2)
  return r > box.l && l < box.r && b > box.t && t < box.b
}

describe('走廊尺寸', () => {
  it('跟画布卡片的实际尺寸一致，否则避让全是白算', () => {
    expect(ROUTE_SIZE).toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT })
  })
})

describe('走线的样子', () => {
  it('每一段都横平竖直', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 336), node('c', 0, 672)]
    const routes = routeEdges(nodes, [edge('a', 'b'), edge('b', 'c')])
    for (const points of routes.values()) {
      for (const seg of segments(points)) {
        const flat = Math.abs(seg.y1 - seg.y2) < 0.01
        const upright = Math.abs(seg.x1 - seg.x2) < 0.01
        expect(flat || upright).toBe(true)
      }
    }
  })

  it('一个节点扇出三条时共用同一条主干：先汇聚再分支', () => {
    const nodes = [node('a', 0, 0), node('b', 0, 336), node('c', 400, 336), node('d', 800, 336)]
    const routes = routeEdges(nodes, [edge('a', 'b'), edge('a', 'c'), edge('a', 'd')])
    // 每条边第三段（总线那段横线）的纵坐标应当一致
    const bus = [...routes.values()].map((points) => (points[2] as RoutePoint).y)
    expect(new Set(bus).size).toBe(1)
  })

  it('扇入同一个节点时也共一条汇流线', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 200, 336)]
    const routes = routeEdges(nodes, [edge('a', 'c'), edge('b', 'c')])
    const bus = [...routes.values()].map((points) => (points[1] as RoutePoint).y)
    expect(new Set(bus).size).toBe(1)
  })

  it('中间隔着卡片就绕侧边通道，不穿过去', () => {
    const middle = node('mid', 0, 168)
    const nodes = [node('top', 0, 0), middle, node('bottom', 0, 504)]
    const routes = routeEdges(nodes, [edge('top', 'bottom')])
    const points = routes.get('top->bottom') as readonly RoutePoint[]
    expect(points).toBeDefined()
    // 直落会被 mid 挡住（竖线穿过卡片），只好绕到它的右边
    for (const seg of segments(points)) expect(hits(seg, boxOf(middle))).toBe(false)
    expect(points.some(point => point.x > boxOf(middle).r)).toBe(true)
  })

  it('跨层、同层、绕远的三条边都不压别人的卡片', () => {
    const nodes = [
      node('a', 0, 0), node('b', 400, 0),
      node('c', 0, 168), node('d', 800, 168),
      node('e', 0, 336), node('f', 800, 336),
    ]
    const edges = [edge('a', 'e'), edge('b', 'd'), edge('c', 'f'), edge('e', 'f')]
    const routes = routeEdges(nodes, edges)
    expect(routes.size).toBe(edges.length)
    for (const item of edges) {
      const points = routes.get(item.id) as readonly RoutePoint[]
      for (const seg of segments(points)) {
        for (const other of nodes) {
          // 两端自己的卡片可以贴边，别人的一张都不许穿
          if (other.id === item.from || other.id === item.to) continue
          expect(hits(seg, boxOf(other))).toBe(false)
        }
      }
    }
  })

  it('端点不在画布上的边直接跳过，由调用方退回直线', () => {
    const routes = routeEdges([node('a', 0, 0)], [edge('a', 'ghost')])
    expect(routes.has('a->ghost')).toBe(false)
  })
})

describe('折线转路径', () => {
  it('相邻重复点会被吃掉', () => {
    const path = pathOf([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }])
    expect(path).toBe('M 0 0 L 100 0')
  })

  it('拐角用二次贝塞尔倒圆，短段自动缩小半径', () => {
    const path = pathOf([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 100, y: 6 }])
    // 6px 的短段只给一半半径，否则圆角会画到拐点另一侧
    expect(path).toContain('Q 0 6 3 6')
    expect(path.startsWith('M 0 0 L 0 3')).toBe(true)
  })

  it('同向三点不产生多余的圆角', () => {
    expect(pathOf([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 200 }]))
      .toBe('M 0 0 L 0 100 L 0 200')
  })

  it('只有一点时就是起点', () => {
    expect(pathOf([{ x: 12, y: 34 }])).toBe('M 12 34')
    expect(pathOf([])).toBe('')
  })
})
