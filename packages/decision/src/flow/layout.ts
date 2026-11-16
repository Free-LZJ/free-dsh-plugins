/**
 * 节点自动布局：算出「每个节点该摆在哪」。
 *
 * 分两步：先定**层**（谁在谁后面），再定**层内顺序**，最后按方向映射成坐标。
 * 这样做的好处是加一个方向只是换映射公式，加一种策略只影响层内顺序。
 *
 * @module @free-dsh-plugins/dsh-decision/flow/layout
 */

import type { Flow, FlowNodeSpec } from './types.ts'

/** 一个位置。 */
export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * 流程的走向。
 *
 * - `TB` 自上而下（默认）：读起来是"先发生什么、再发生什么"
 * - `BT` 自下而上：终点在上、起点在下
 * - `LR` 从左到右：分支多、层数少时更省横向空间
 * - `RL` 从右到左
 */
export type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL'

/**
 * 排列方式。
 *
 * - `layered` 分层：同一层的节点对齐成一行，层与层拉开距离，一眼看清阶段
 * - `compact` 紧凑：间距缩一半，节点多的时候一屏能看全
 */
export type LayoutStrategy = 'layered' | 'compact'

/** 布局的尺寸参数。 */
export interface LayoutOptions {
  /** 相邻层之间的间距。 */
  readonly columnWidth?: number
  /** 同层相邻节点的间距。 */
  readonly rowHeight?: number
  /** 节点估算宽度，用来判重叠。 */
  readonly nodeWidth?: number
  /** 节点估算高度。 */
  readonly nodeHeight?: number
  /** 画布左上角留白。 */
  readonly origin?: Point
  /** 走向。 */
  readonly direction?: LayoutDirection
  /** 排列方式。 */
  readonly strategy?: LayoutStrategy
  /**
   * 人摆过的位置要不要保留。
   *
   * 默认 `true`（打开页面时不动手摆过的东西）；「自动布局」按钮传 `false`，
   * 否则点了没反应——它保留的正是用户想重排的那些。
   */
  readonly keepManual?: boolean
}

const DEFAULTS = {
  /** 层间距（纵向排列时是 y 方向）。 */
  columnWidth: 140,
  /** 同层间距（纵向排列时是 x 方向）。 */
  rowHeight: 250,
  nodeWidth: 200,
  nodeHeight: 64,
  origin: { x: 60, y: 40 } as Point,
  direction: 'TB' as LayoutDirection,
  strategy: 'layered' as LayoutStrategy,
  keepManual: true,
}

/** 紧凑模式把两个间距都收紧。 */
const COMPACT = { columnWidth: 90, rowHeight: 160 }

/**
 * 算出每个节点的位置。
 * @param flow - 图。
 * @param options - 尺寸、方向与策略。
 * @returns 节点 id → 坐标；包含全部节点。
 */
export function resolvePositions(flow: Flow, options: LayoutOptions = {}): ReadonlyMap<string, Point> {
  const base = { ...DEFAULTS, ...options }
  const sized = base.strategy === 'compact'
    ? { ...base, ...COMPACT, ...options }
    : base

  const layers = layerOf(flow)

  /**
   * 已经占住的位置，**按层分开记**。
   *
   * 不同层的节点在层轴上本来就分开，不该互相判重叠——否则第二层的第一个节点会被
   * 判成和第一层撞上，白白往层内挪一格。
   */
  const takenByLayer = new Map<number, Point[]>()
  const take = (layer: number, point: Point): void => {
    const list = takenByLayer.get(layer)
    if (list === undefined) takenByLayer.set(layer, [point])
    else list.push(point)
  }
  const result = new Map<string, Point>()
  if (sized.keepManual) {
    for (const node of flow.nodes) {
      if (node.pos !== undefined) {
        result.set(node.id, node.pos)
        take(layers.get(node.id) ?? 0, node.pos)
      }
    }
  }

  /** 每个节点的前驱，用来算「重心」。 */
  const inbound = new Map<string, string[]>()
  for (const node of flow.nodes) inbound.set(node.id, [])
  for (const node of flow.nodes) {
    for (const edge of node.out ?? []) inbound.get(edge.to)?.push(node.id)
  }

  /**
   * 重心：前驱在**层内那一轴**上的平均值。
   *
   * 没有这一步，同层节点只会按文件顺序排，一条链走下来是斜的——看图的人得追着线跑。
   */
  /** 层内那一轴上 `origin` 的分量：没有前驱的节点从这里开始排。 */
  const originAlong = sized.direction === 'LR' || sized.direction === 'RL'
    ? sized.origin.y
    : sized.origin.x

  const barycenter = (id: string): number => {
    const sources = (inbound.get(id) ?? [])
      .map(source => result.get(source))
      .filter((point): point is Point => point !== undefined)
      .map(point => alongOf(point, sized.direction))
    // 没有前驱时从原点上按声明顺序排开，别的节点才有得对齐。
    if (sources.length === 0) return originAlong + indexOf(flow, id) * sized.rowHeight
    return sources.reduce((sum, value) => sum + value, 0) / sources.length
  }

  const pending = flow.nodes.filter(node => !result.has(node.id))
  pending.sort((left, right) => {
    const byLayer = (layers.get(left.id) ?? 0) - (layers.get(right.id) ?? 0)
    if (byLayer !== 0) return byLayer
    const byCenter = barycenter(left.id) - barycenter(right.id)
    return byCenter !== 0 ? byCenter : indexOf(flow, left.id) - indexOf(flow, right.id)
  })

  for (const node of pending) {
    const layer = layers.get(node.id) ?? 0
    // 沿层轴的位置由层号直接定；层内那一轴从重心开始找空位。
    let along = Math.max(0, barycenter(node.id))
    let guard = 0
    let point = place(layer, along, sized)
    while (overlaps(point, takenByLayer.get(layer) ?? [], sized) && guard < flow.nodes.length * 4 + 8) {
      along += sized.rowHeight
      point = place(layer, along, sized)
      guard += 1
    }
    result.set(node.id, point)
    take(layer, point)
  }

  return result
}

/**
 * 把「第几层 + 层内位置」映射成一个坐标。
 * @param layer - 层号，0 是最上游。
 * @param along - 层内位置（离原点多远）。
 * @param sized - 尺寸与方向。
 * @returns 坐标。
 */
function place(layer: number, along: number, sized: typeof DEFAULTS | (typeof DEFAULTS & typeof COMPACT)): Point {
  // `along` 已经是绝对坐标（重心算出来的就是），只有层轴要加 `origin`。
  const depth = layer * sized.columnWidth
  const { x: ox, y: oy } = sized.origin
  switch (sized.direction) {
    case 'LR':
      return { x: ox + depth, y: along }
    case 'RL':
      return { x: ox - depth, y: along }
    case 'BT':
      return { x: along, y: oy - depth }
    default:
      return { x: along, y: oy + depth }
  }
}

/** 一个坐标在「层内那一轴」上的值，用来算重心。 */
function alongOf(point: Point, direction: LayoutDirection): number {
  return direction === 'LR' || direction === 'RL' ? point.y : point.x
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
function overlaps(
  point: Point,
  taken: readonly Point[],
  sized: typeof DEFAULTS | (typeof DEFAULTS & typeof COMPACT),
): boolean {
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
