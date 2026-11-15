/**
 * 自动布局：给没有坐标的节点分配位置，**保留人摆过的位置**。
 *
 * 这是「agent 改结构、人摆布局」的交界。三条约束：
 *
 * 1. **有 `pos` 的节点一个像素都不动**。新增一个节点不该把整张图重排——那会让人下次
 *    打开时认不出自己刚整理过的图。
 * 2. **没有 `pos` 的才参与计算**，而且只在自己的层里找空位。
 * 3. **结果确定**：同一张图反复算，坐标一致。否则每次刷新图都在跳。
 *
 * 分层用最长路径深度（触发器在第 0 层，动作往下推），层内垂直排列。没有用通用图布局库：
 * 流程图的形状很规整（触发 → 分支 → 动作），交叉本来就少，一个几十行的分层算法够了。
 *
 * @module @free-lzj/dsh-decision/flow/layout
 */

import type { Flow, FlowNodeSpec } from './types.ts'

/** 一个点的坐标（节点左上角）。 */
export interface Point {
  readonly x: number
  readonly y: number
}

/** 布局的尺寸参数。 */
export interface LayoutOptions {
  /** 相邻层的水平间距。 */
  readonly columnWidth?: number
  /** 同层相邻节点的垂直间距。 */
  readonly rowHeight?: number
  /** 节点估算宽度，用来判重叠。 */
  readonly nodeWidth?: number
  /** 节点估算高度。 */
  readonly nodeHeight?: number
  /** 画布左上角留白。 */
  readonly origin?: Point
}

const DEFAULTS = {
  columnWidth: 260,
  rowHeight: 120,
  nodeWidth: 180,
  nodeHeight: 64,
  origin: { x: 40, y: 40 } as Point,
}

/**
 * 算出每个节点的位置。
 * @param flow - 图。
 * @param options - 尺寸参数。
 * @returns 节点 id → 坐标；包含全部节点。
 */
export function resolvePositions(flow: Flow, options: LayoutOptions = {}): ReadonlyMap<string, Point> {
  const sized = { ...DEFAULTS, ...options }
  const layers = layerOf(flow)

  /** 已经占住的位置：人摆过的，加上本次已经分配出去的。 */
  const taken: Point[] = []
  const result = new Map<string, Point>()

  for (const node of flow.nodes) {
    if (node.pos !== undefined) {
      result.set(node.id, node.pos)
      taken.push(node.pos)
    }
  }

  /** 按层、再按图里的先后顺序分配，保证确定性。 */
  const pending = flow.nodes.filter(node => node.pos === undefined)
  pending.sort((left, right) => {
    const byLayer = (layers.get(left.id) ?? 0) - (layers.get(right.id) ?? 0)
    return byLayer !== 0 ? byLayer : indexOf(flow, left.id) - indexOf(flow, right.id)
  })

  for (const node of pending) {
    const layer = layers.get(node.id) ?? 0
    const x = sized.origin.x + layer * sized.columnWidth
    let y = sized.origin.y
    // 往下找第一个不与已占位置相交的槽位。
    while (overlaps({ x, y }, taken, sized)) y += sized.rowHeight
    const point = { x, y }
    result.set(node.id, point)
    taken.push(point)
  }

  return result
}

/**
 * 每个节点在第几层：从入度为 0 的节点出发，取最长路径。
 *
 * 用最长路径而不是最短，是为了让「汇合点」落在所有前驱都走完之后——最短路径会把
 * join 提到它两个前驱之间，画出来线是往回折的。
 * @param flow - 图。
 * @returns 节点 id → 层号。
 */
export function layerOf(flow: Flow): ReadonlyMap<string, number> {
  const inbound = new Map<string, string[]>()
  for (const node of flow.nodes) inbound.set(node.id, [])
  for (const node of flow.nodes) {
    for (const edge of node.out ?? []) inbound.get(edge.to)?.push(node.id)
  }

  const layers = new Map<string, number>()
  const pending = flow.nodes.filter(node => (inbound.get(node.id) ?? []).length === 0)
  for (const node of pending) layers.set(node.id, 0)

  // 反复松弛直到稳定。图已在解析期判过无环，所以一定会收敛。
  let changed = true
  let guard = 0
  while (changed && guard < flow.nodes.length * flow.nodes.length + 1) {
    changed = false
    guard += 1
    for (const node of flow.nodes) {
      const sources = inbound.get(node.id) ?? []
      if (sources.length === 0) continue
      let best = -1
      for (const source of sources) {
        const known = layers.get(source)
        if (known === undefined) { best = -1; break }
        if (known > best) best = known
      }
      if (best < 0) continue
      const next = best + 1
      if ((layers.get(node.id) ?? -1) < next) {
        layers.set(node.id, next)
        changed = true
      }
    }
  }

  // 没算到的（理论上不该有）落到最后一层，至少给个位置。
  const deepest = Math.max(0, ...[...layers.values()])
  for (const node of flow.nodes) {
    if (!layers.has(node.id)) layers.set(node.id, deepest + 1)
  }
  return layers
}

/** 两个矩形是否相交（按尺寸估算）。 */
function overlaps(point: Point, taken: readonly Point[], sized: typeof DEFAULTS): boolean {
  return taken.some(other => {
    const dx = Math.abs(other.x - point.x)
    const dy = Math.abs(other.y - point.y)
    return dx < sized.nodeWidth && dy < sized.nodeHeight
  })
}

/** 节点在图里的下标，用来给同层节点排一个稳定的先后。 */
function indexOf(flow: Flow, id: string): number {
  return flow.nodes.findIndex((node: FlowNodeSpec) => node.id === id)
}
