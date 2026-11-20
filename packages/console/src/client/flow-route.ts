/**
 * 连线的走法：横平竖直，扇出共用一条主干、汇入共用一条汇流线，跨层的长边绕到
 * 卡片区外侧的通道里走。
 *
 * **为什么不交给库**：贝塞尔（React Flow 默认的 `default`）在「一个 switch 扇三条、
 * 三条再扇回 end」的图上，曲线会从别的卡片身上扫过去；`mail` 那种 8 层 5 车道的子图
 * 更是一屏糊线。正交走线的好处是**每条线占的走廊是确定的**，压不压卡片可以判定——
 * 判定不过就退到侧边通道，于是「连线穿过节点」从「看运气」变成「不会」。
 *
 * 纯函数，坐标与画布同源。尺寸默认取 `NODE_WIDTH/NODE_HEIGHT`，由调用方传入时以调用方为准。
 *
 * @module @free-dsh-plugins/dsh-console/client/flow-route
 */

import type { CanvasEdge, CanvasNode } from './flow-canvas.tsx'

/** 走线的一个拐点。 */
export interface RoutePoint {
  readonly x: number
  readonly y: number
}

/** 卡片尺寸。 */
export interface RouteSize {
  readonly width: number
  readonly height: number
}

/**
 * 默认尺寸。**必须与 `flow-canvas.tsx` 的 `NODE_WIDTH/NODE_HEIGHT` 相等**——
 * 否则算出来的走廊和真实卡片对不上，避让就白算了（`flow-route.spec.ts` 里钉了这条）。
 */
export const ROUTE_SIZE: RouteSize = { width: 280, height: 104 }

/** 相邻层之间的空档：总线在这条缝里走。 */
const BUS = 24
/** 判定碰撞时给卡片外扩的余量。 */
const PAD = 6
/** 侧边通道离卡片区多远。 */
const GUTTER = 28
/** 短头的候选长度：从卡片边往外伸多少再拐。 */
const STUBS = [12, 24, 36]

interface Rect {
  readonly id: string
  readonly l: number
  readonly t: number
  readonly r: number
  readonly b: number
}

/** 一段横线有没有压到卡片。端点贴边不算压。 */
function crossesH(x1: number, x2: number, y: number, rects: readonly Rect[]): boolean {
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  return rects.some(rect => y > rect.t - PAD && y < rect.b + PAD && right > rect.l && left < rect.r)
}

/** 一段竖线有没有压到卡片。 */
function crossesV(y1: number, y2: number, x: number, rects: readonly Rect[]): boolean {
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  return rects.some(rect => x > rect.l - PAD && x < rect.r + PAD && bottom > rect.t && top < rect.b)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

/**
 * 总线纵坐标的候选：先试理想位置，被挡了就上下平移几像素。
 *
 * 为什么不是「被挡了就换条路」：同一层的兄弟节点各自找空位，扇出的主干就散了，
 * 「先汇聚再分支」的观感立刻消失。挪几像素还能撞上别的线，但至少主干是直的。
 */
function busCandidates(preferred: number, lo: number, hi: number): number[] {
  const base = clamp(preferred, Math.min(lo, hi), Math.max(lo, hi))
  const out = [base]
  for (const delta of [8, -8, 16, -16, 24, -24]) {
    const y = clamp(base + delta, Math.min(lo, hi), Math.max(lo, hi))
    if (!out.includes(y)) out.push(y)
  }
  return out
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 单条边的走法。
 *
 * 两个分支按「好看 → 一定不压卡片」排序：
 * 1. **层间直落**（源在上一层的空档里够宽）：上行 → 总线 → 平移 → 下行。扇出/汇入的
 *    兄弟节点会因为 `stats` 里的计数挑中同一条总线，于是天然汇聚成一条主干。
 * 2. **侧边通道**：跨层、同层、回流都从卡片区外侧绕。通道横坐标取「所有挡路卡片
 *    再往外 GUTTER」，所以那段竖线一定不压卡片。
 * 3. 兜底：贴整张图最外侧绕。★ 只在极端拥挤的图上走到，允许压卡片。
 */
function routeOne(
  from: Rect,
  to: Rect,
  stats: { readonly out: ReadonlyMap<string, number>; readonly in: ReadonlyMap<string, number> },
  rects: readonly Rect[],
): RoutePoint[] {
  const cx1 = (from.l + from.r) / 2
  const cx2 = (to.l + to.r) / 2
  const obstacles = rects.filter(rect => rect.id !== from.id && rect.id !== to.id)

  // ① 层间直落。
  if (to.t - from.b >= BUS + 8) {
    const fanIn = (stats.in.get(to.id) ?? 0) > 1
    const fanOut = (stats.out.get(from.id) ?? 0) > 1
    const preferred = fanIn ? to.t - BUS : fanOut ? from.b + BUS : (from.b + to.t) / 2
    for (const busY of busCandidates(preferred, from.b + 12, to.t - 12)) {
      if (crossesH(cx1, cx2, busY, obstacles)) continue
      if (crossesV(from.b, busY, cx1, obstacles)) continue
      if (crossesV(busY, to.t, cx2, obstacles)) continue
      return [
        { x: cx1, y: from.b },
        { x: cx1, y: busY },
        { x: cx2, y: busY },
        { x: cx2, y: to.t },
      ]
    }
  }

  // ② 侧边通道。
  const top = Math.min(from.b, to.t) - BUS
  const bottom = Math.max(from.b, to.t) + BUS
  const blocking = obstacles.filter(rect => rect.b > top && rect.t < bottom)
  const rightX = Math.max(from.r, to.r, ...blocking.map(rect => rect.r)) + GUTTER
  const leftX = Math.min(from.l, to.l, ...blocking.map(rect => rect.l)) - GUTTER
  const gx = Math.abs(rightX - (cx1 + cx2) / 2) <= Math.abs((cx1 + cx2) / 2 - leftX) ? rightX : leftX
  for (const stubOut of STUBS) {
    for (const stubIn of STUBS) {
      const y1 = from.b + stubOut
      const y2 = to.t - stubIn
      if (crossesH(cx1, gx, y1, obstacles)) continue
      if (crossesH(gx, cx2, y2, obstacles)) continue
      if (crossesV(y1, y2, gx, obstacles)) continue
      return [
        { x: cx1, y: from.b },
        { x: cx1, y: y1 },
        { x: gx, y: y1 },
        { x: gx, y: y2 },
        { x: cx2, y: y2 },
        { x: cx2, y: to.t },
      ]
    }
  }

  // ③ 兜底：从整张图外围绕过去。★ 极端拥挤时才会走到，这里不保证不压卡片。
  const farRight = Math.max(...rects.map(rect => rect.r)) + GUTTER
  const farTop = Math.min(...rects.map(rect => rect.t)) - BUS
  return [
    { x: cx1, y: from.b },
    { x: cx1, y: farTop },
    { x: farRight, y: farTop },
    { x: farRight, y: to.t - 12 },
    { x: cx2, y: to.t - 12 },
    { x: cx2, y: to.t },
  ]
}

/**
 * 给每条边算一组拐点。
 *
 * @param nodes - 画布节点（取 `x/y` 左上角坐标）。
 * @param edges - 画布边。
 * @param size - 卡片尺寸，默认 {@link ROUTE_SIZE}。
 * @returns 边 id → 正交点集。没算出来的边不在表里，调用方退回直线。
 */
export function routeEdges(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  size: RouteSize = ROUTE_SIZE,
): Map<string, readonly RoutePoint[]> {
  const rects: Rect[] = nodes.map(node => ({
    id: node.id,
    l: node.x,
    t: node.y,
    r: node.x + size.width,
    b: node.y + size.height,
  }))
  const byId = new Map(rects.map(rect => [rect.id, rect]))
  const fanOut = new Map<string, number>()
  const fanIn = new Map<string, number>()
  for (const edge of edges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1)
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  }
  const stats = { out: fanOut, in: fanIn }
  const routes = new Map<string, readonly RoutePoint[]>()
  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    routes.set(edge.id, routeOne(from, to, stats, rects))
  }
  return routes
}

/**
 * 折线 → SVG path，拐角用二次贝塞尔倒圆。
 *
 * 半径按「相邻两段长度的一半」收缩（`r = min(8, len1/2, len2/2)`），否则短段会把
 * 圆角画到拐点另一侧，出现反向的自交小钩。
 *
 * @param points - {@link routeEdges} 的输出，任意方向的折线。
 * @param radius - 圆角上限，默认 8。
 */
export function pathOf(points: readonly RoutePoint[], radius = 8): string {
  const clean: RoutePoint[] = []
  for (const point of points) {
    const last = clean[clean.length - 1]
    if (last !== undefined && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue
    clean.push(point)
  }
  if (clean.length === 0) return ''
  const head = clean[0] as RoutePoint
  if (clean.length === 1) return `M ${round(head.x)} ${round(head.y)}`
  let path = `M ${round(head.x)} ${round(head.y)}`
  for (let index = 1; index < clean.length - 1; index += 1) {
    const prev = clean[index - 1] as RoutePoint
    const point = clean[index] as RoutePoint
    const next = clean[index + 1] as RoutePoint
    const inX = Math.sign(point.x - prev.x)
    const inY = Math.sign(point.y - prev.y)
    const outX = Math.sign(next.x - point.x)
    const outY = Math.sign(next.y - point.y)
    if ((inX === 0 && outX === 0) || (inY === 0 && outY === 0)) {
      path += ` L ${round(point.x)} ${round(point.y)}`
      continue
    }
    const len1 = Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y)
    const len2 = Math.abs(next.x - point.x) + Math.abs(next.y - point.y)
    const r = Math.min(radius, len1 / 2, len2 / 2)
    path += ` L ${round(point.x - inX * r)} ${round(point.y - inY * r)}`
    path += ` Q ${round(point.x)} ${round(point.y)} ${round(point.x + outX * r)} ${round(point.y + outY * r)}`
  }
  const tail = clean[clean.length - 1] as RoutePoint
  path += ` L ${round(tail.x)} ${round(tail.y)}`
  return path
}
