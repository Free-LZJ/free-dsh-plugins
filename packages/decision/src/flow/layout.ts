/**
 * 节点自动布局：算出「每个节点该摆在哪」。
 *
 * 分两步：先定**层**（谁在谁后面），再定**层内顺序**，最后按方向映射成坐标。
 * 这样做的好处是加一个方向只是换映射公式，加一种策略只影响层内顺序。
 *
 * **间距是「卡片尺寸 + 空隙」，不是固定像素。** 早先这里直接写 140 / 250 两档步长，
 * 而画布上的卡片是 280×104——于是同层相邻的两张卡必定叠 30px，左右走向时相邻两层
 * 更是叠掉 140px。布局算得对不对不取决于这里的数字好不好看，而取决于它和画布画的
 * 那张卡是不是同一个尺寸，所以尺寸只有 {@link NODE_SIZE} 一处，画布也从这里取。
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
 * 画布上一张卡片的估算尺寸。
 *
 * 布局按它算间距，画布按它决定自己的宽高——**两处必须是同一个数**，否则排得再整齐
 * 卡片也会叠在一起。改这里等于同时改布局与界面。
 */
export const NODE_SIZE = { width: 280, height: 104 } as const

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
 * - `compact` 紧凑：空隙缩一半，节点多的时候一屏能看全
 */
export type LayoutStrategy = 'layered' | 'compact'

/** 同层多个节点的对齐方式。 */
export type LayoutAlign = 'start' | 'center' | 'end'

/** 布局的尺寸参数。 */
export interface LayoutOptions {
  /**
   * 层与层之间的空隙（**不含**卡片自身厚度）。
   *
   * 层轴上的实际步长 = 该方向上的卡片厚度 + 这个空隙：纵向排列时是高度，横向是宽度。
   */
  readonly layerGap?: number
  /** 同一层里相邻两个节点之间的空隙（不含卡片尺寸）；层内实际步长 = 卡片宽/高 + 它。 */
  readonly laneGap?: number
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
   * 一层里有多个节点时怎么对齐。
   *
   * - center（默认）以父节点为中心左右展开——父节点落在子节点的正中上方，
   *   这是看流程图最自然的读法
   * - start 从父节点往一侧铺开（父节点在排头）
   * - end 往另一侧铺开（父节点在排尾）
   */
  readonly align?: LayoutAlign
  /**
   * 人摆过的位置要不要保留。
   *
   * 默认 `true`（打开页面时不动手摆过的东西）；「自动布局」按钮传 `false`，
   * 否则点了没反应——它保留的正是用户想重排的那些。
   */
  readonly keepManual?: boolean
}

/** 合并完选项之后的尺寸参数：每一项都有值。 */
interface Sizing {
  readonly layerGap: number
  readonly laneGap: number
  readonly nodeWidth: number
  readonly nodeHeight: number
  readonly origin: Point
  readonly direction: LayoutDirection
  readonly strategy: LayoutStrategy
  readonly align: LayoutAlign
  readonly keepManual: boolean
}

const DEFAULTS: Sizing = {
  /** 层间空隙。 */
  layerGap: 64,
  /** 层内空隙。 */
  laneGap: 56,
  nodeWidth: NODE_SIZE.width,
  nodeHeight: NODE_SIZE.height,
  origin: { x: 60, y: 40 },
  direction: 'TB',
  strategy: 'layered',
  align: 'center',
  keepManual: true,
}

/** 紧凑模式把两个空隙都收紧。 */
const COMPACT = { layerGap: 32, laneGap: 20 }

/** 一张图算坐标时要用到的尺寸与步长；先算一次，后面都读它。 */
interface Geometry {
  readonly direction: LayoutDirection
  readonly width: number
  readonly height: number
  readonly origin: Point
  /** 层轴上的步长（纵向排列时是 y）。 */
  readonly layerPitch: number
  /** 层内那一轴上的步长（纵向排列时是 x）。 */
  readonly lanePitch: number
  /** 层内那一轴的原点分量：没有前驱的节点从这里开始排。 */
  readonly laneAxisOrigin: number
}

/**
 * 算出每个节点的位置。
 * @param flow - 图。
 * @param options - 尺寸、方向与策略。
 * @returns 节点 id → 坐标；包含全部节点。
 */
export function resolvePositions(flow: Flow, options: LayoutOptions = {}): ReadonlyMap<string, Point> {
  const base: Sizing = {
    layerGap: options.layerGap ?? DEFAULTS.layerGap,
    laneGap: options.laneGap ?? DEFAULTS.laneGap,
    nodeWidth: options.nodeWidth ?? DEFAULTS.nodeWidth,
    nodeHeight: options.nodeHeight ?? DEFAULTS.nodeHeight,
    origin: options.origin ?? DEFAULTS.origin,
    direction: options.direction ?? DEFAULTS.direction,
    strategy: options.strategy ?? DEFAULTS.strategy,
    align: options.align ?? DEFAULTS.align,
    keepManual: options.keepManual ?? DEFAULTS.keepManual,
  }
  const sized: Sizing = base.strategy === 'compact' ? { ...base, ...COMPACT } : base
  const geom = geometryOf(sized)

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
  const barycenter = (id: string): number => {
    const sources = (inbound.get(id) ?? [])
      .map(source => result.get(source) ?? raw.get(source))
      .filter((point): point is Point => point !== undefined)
      .map(point => alongOf(point, sized.direction))
    // 没有前驱时从原点上按声明顺序排开，别的节点才有得对齐。
    if (sources.length === 0) return geom.laneAxisOrigin + indexOf(flow, id) * geom.lanePitch
    return sources.reduce((sum, value) => sum + value, 0) / sources.length
  }

  const pending = flow.nodes.filter(node => !result.has(node.id))

  /** 按层分组：对齐方式要看整层才好算，逐个排做不到「以父节点为中心」。 */
  const byLayer = new Map<number, FlowNodeSpec[]>()
  for (const node of pending) {
    const layer = layers.get(node.id) ?? 0
    const list = byLayer.get(layer)
    if (list === undefined) byLayer.set(layer, [node])
    else list.push(node)
  }

  /** 候选位置。可能是负的——最后统一平移回 `origin`。 */
  const raw = new Map<string, Point>()

  for (const [layer, list] of [...byLayer.entries()].sort((left, right) => left[0] - right[0])) {
    list.sort((left, right) => {
      const byCenter = barycenter(left.id) - barycenter(right.id)
      return byCenter !== 0 ? byCenter : indexOf(flow, left.id) - indexOf(flow, right.id)
    })

    /** 这一层的中心：各节点父重心的平均。没有父节点的层（根）就用它自己的重心。 */
    const centers = list.map(node => barycenter(node.id))
    const layerCenter = centers.reduce((sum, value) => sum + value, 0) / centers.length
    const last = list.length - 1
    /** 这一层已经摆下的位置——判重叠只在**同一层**里判，跨层在层轴上本来就是分开的。 */
    const taken = takenByLayer.get(layer) ?? []

    list.forEach((node, index) => {
      // `center`：以层中心为中轴左右展开，父节点正好落在子节点中间的上方。
      const offset = sized.align === 'start'
        ? index
        : sized.align === 'end'
          ? index - last
          : index - last / 2
      let along = layerCenter + offset * geom.lanePitch
      let point = place(layer, along, geom)
      // 撞上同层的谁就往同侧让一格（取真实宽度判，不让半步）。
      let guard = 0
      while (taken.some(other => overlaps(point, other, geom)) && guard < 32) {
        guard += 1
        along += geom.lanePitch
        point = place(layer, along, geom)
      }
      raw.set(node.id, point)
      taken.push(point)
    })
  }

  /**
   * 归一化：把整张图平移到 `origin` 右上，别让算出来的坐标落到画布外面去。
   *
   * **两个轴都要归一化**：`BT` / `RL` 的层轴是往负方向长的，只收层内那一轴的话，
   * 反方向布局会把半张图甩到负坐标里。
   */
  if (raw.size > 0) {
    const xs = [...raw.values()].map(point => point.x)
    const ys = [...raw.values()].map(point => point.y)
    const shiftX = geom.origin.x - Math.min(...xs)
    const shiftY = geom.origin.y - Math.min(...ys)
    if (shiftX !== 0 || shiftY !== 0) {
      for (const [id, point] of raw) raw.set(id, { x: point.x + shiftX, y: point.y + shiftY })
    }
  }

  for (const [id, point] of raw) {
    result.set(id, point)
    take(layers.get(id) ?? 0, point)
  }

  return result
}

/**
 * 算出一张图用到的尺寸与两个轴上的步长。
 * @param sized - 合并好的选项。
 * @returns 几何参数。
 */
function geometryOf(sized: Sizing): Geometry {
  const vertical = sized.direction === 'TB' || sized.direction === 'BT'
  return {
    direction: sized.direction,
    width: sized.nodeWidth,
    height: sized.nodeHeight,
    origin: sized.origin,
    // 层轴：纵向排列时沿 y 走，卡片占的是**高度**；横向排列时沿 x 走，占的是宽度。
    layerPitch: (vertical ? sized.nodeHeight : sized.nodeWidth) + sized.layerGap,
    lanePitch: (vertical ? sized.nodeWidth : sized.nodeHeight) + sized.laneGap,
    laneAxisOrigin: vertical ? sized.origin.x : sized.origin.y,
  }
}

/**
 * 把「第几层 + 层内位置」映射成一个坐标。
 * @param layer - 层号，0 是最上游。
 * @param along - 层内位置（绝对坐标）。
 * @param geom - 尺寸与步长。
 * @returns 坐标。
 */
function place(layer: number, along: number, geom: Geometry): Point {
  // `along` 已经是绝对坐标（重心算出来的就是），只有层轴要加 `origin`。
  const depth = layer * geom.layerPitch
  const { x: ox, y: oy } = geom.origin
  switch (geom.direction) {
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

/**
 * 两张卡片是否叠在一起。
 *
 * 边贴边不算叠：`<` 而不是 `<=`。
 * @param point - 待摆的位置。
 * @param other - 这一层已经占住的一个位置。
 * @param geom - 卡片尺寸。
 * @returns 撞上了就是 true。
 */
function overlaps(point: Point, other: Point, geom: Geometry): boolean {
  return Math.abs(other.x - point.x) < geom.width && Math.abs(other.y - point.y) < geom.height
}

/** 节点在图里的下标，用来给同层节点排一个稳定的先后。 */
function indexOf(flow: Flow, id: string): number {
  return flow.nodes.findIndex((node: FlowNodeSpec) => node.id === id)
}
