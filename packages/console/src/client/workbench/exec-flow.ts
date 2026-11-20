/**
 * 一次执行走过的图：流程定义 × 这条任务的记录。
 *
 * 看板上以前只有一条「链」——那是引擎的动作流水账。用户在实例详情里要看的不是
 * 流水账，是「**从我改的那张图上看，这一次跑到哪儿了**」。所以这里把定义页那份
 * 图摊开（共用 `toCanvas`，两处长得一模一样），再给每一格补上它此刻的处境。
 *
 * **扁平化**：子工作流不再分 tab，全部画进同一张画布——主图在左，本次跑过的子流程
 * 依序排在右侧，用一条虚线从父节点指过去。分 tab 时「从这一步点进了另一个图」这个
 * 事实在界面上是断的，得自己记住刚才在哪张图里。
 *
 * 全是纯函数：颜色、文案、渲染都在组件里，这里只回答「哪一格是什么状态、
 * 这个节点跑了哪些次、参数展开成什么」。
 *
 * @module @free-dsh-plugins/dsh-console/client/workbench/exec-flow
 */

import type { Task, TaskNodeRecord } from '../../protocol.ts'
import type { CanvasEdge, CanvasNode } from '../flow-canvas.tsx'
import { NODE_HEIGHT, NODE_WIDTH } from '../flow-canvas.tsx'
import { toCanvas } from '../flow-view.tsx'
import type { TriageFlow, TriageNodeType } from '../rules.tsx'

/** 一个方块此刻的处境。`idle` 表示这次没走到它。 */
export type FlowMark = 'ok' | 'failed' | 'running' | 'suspended' | 'next' | 'idle'

/**
 * 记录属于哪张图。
 *
 * `primary` = 主图：进度（running/ready/suspendedAt）只落主图，老记录也可能没有
 * `flowId`——这两种都只有主图能兜住。
 */
export interface FlowScope {
  readonly id: string
  readonly primary: boolean
}

/** 扁平 id 的分隔符：`mail::mail__3`。子图里有 `start__0`/`end__0` 这种跨图重名的格子。 */
const FLAT_SEPARATOR = '::'

/** 扁平 id → 是哪张图的哪个节点。 */
export function splitFlatId(flatId: string): { flowId: string; nodeId: string } {
  const at = flatId.indexOf(FLAT_SEPARATOR)
  if (at < 0) return { flowId: '', nodeId: flatId }
  return { flowId: flatId.slice(0, at), nodeId: flatId.slice(at + FLAT_SEPARATOR.length) }
}

/** 节点 id + 图 id → 画布上的扁平 id。 */
export function flatIdOf(flowId: string, nodeId: string): string {
  return `${flowId}${FLAT_SEPARATOR}${nodeId}`
}

/**
 * 这条任务在这张图的这个节点上的全部记录，按时间升序。
 *
 * 一个节点可能跑不止一次（重试、循环回到同一格）；以前 `find` 只取第一条，
 * 重试的过程就看不见了。有 `runId` 时只看本轮——历史轮次的记录留在 `nodes` 里，
 * 不该混进这一次的点亮。
 */
export function recordsIn(task: Task, scope: FlowScope, nodeId: string): TaskNodeRecord[] {
  const all = task.nodes.filter(node => node.nodeId === nodeId
    && (node.flowId === scope.id || (scope.primary && node.flowId === undefined)))
  const scoped = task.runId === undefined
    ? all
    : all.filter(node => node.runId === undefined || node.runId === task.runId)
  // 旧记录没有 runId；若本轮一条都对不上，宁可全给，也别显示成「没跑过」。
  return [...(scoped.length > 0 ? scoped : all)].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

/**
 * 一格的处境。
 *
 * 顺序是有讲究的：正在跑的压过一切；挂起的记录本身也是 `ok: true`，不先判
 * 黄色就会被绿色盖掉（定义页以前就踩过这个坑）；失败压过成功，因为「重试前那次
 * 挂了」也得让用户看见；`done` 兜底那些没留记录的格子。
 */
export function markIn(task: Task, scope: FlowScope, nodeId: string): FlowMark {
  const progress = task.progress
  // 进度只落主图：子流程内部不落 progress，那边的实时态由主图那格承担。
  if (scope.primary) {
    if (progress?.running?.includes(nodeId) === true) return 'running'
    if (progress?.suspendedAt === nodeId) return 'suspended'
  }
  const records = recordsIn(task, scope, nodeId)
  const last = records[records.length - 1]
  if (last !== undefined && !last.ok) return 'failed'
  if (last !== undefined) return 'ok'
  if (scope.primary && progress?.done?.includes(nodeId) === true) return 'ok'
  if (scope.primary && progress?.ready?.includes(nodeId) === true) return 'next'
  return 'idle'
}

/**
 * 这次执行碰过哪几张图，主图排第一。
 *
 * 记录按时间落，子图可能先出现，所以不能直接拿出现顺序当顺序——有 `trigger` 的那张
 * 才是用户心里的「主图」。
 */
export function flowIdsOf(task: Task, flows: readonly TriageFlow[]): string[] {
  const order: string[] = []
  for (const node of task.nodes) {
    const id = node.flowId
    if (id !== undefined && !order.includes(id)) order.push(id)
  }
  const primary = flows.find(flow => flow.trigger !== undefined && order.includes(flow.id))?.id ?? order[0]
  if (primary === undefined) return order
  return [primary, ...order.filter(id => id !== primary)]
}

/** 扁平的画布：主图 + 本次跑过的子工作流，全在一张图上。 */
export interface FlatGraph {
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
  /** 主图 id：详情里要区分「这格属于哪张图」。 */
  readonly primary: string
}

/** 主图与右侧子流程区之间的空档。 */
const GAP_X = 180
/** 子流程之间竖着排的空档。 */
const GAP_Y = 140

interface Bounds {
  readonly width: number
  readonly height: number
}

function boundsOf(nodes: readonly CanvasNode[]): Bounds {
  let width = 0
  let height = 0
  for (const node of nodes) {
    width = Math.max(width, node.x + NODE_WIDTH)
    height = Math.max(height, node.y + NODE_HEIGHT)
  }
  return { width, height }
}

/** 子流程的入口格：优先触发节点，否则就取最上面那个。 */
function entryOf(nodes: readonly CanvasNode[]): CanvasNode | undefined {
  return nodes.find(node => node.group === 'trigger')
    ?? [...nodes].sort((left, right) => left.y - right.y || left.x - right.x)[0]
}

/**
 * 把这次执行碰过的图摊成一张。
 *
 * 只展开**本次有记录**的子流程：没跑到的工作流铺进来只会让图更长，还全是灰的。
 * 连线在同图内保留原样；跨图只画一条虚线，从父节点指向子流程入口——够说明
 * 「这一步钻进了哪个图」，也不用猜子图内部是怎么串起来的。
 *
 * @returns 没有可画的图时 `undefined`（界面显示「没有执行记录」）。
 */
export function flatRunGraphOf(
  task: Task,
  flows: readonly TriageFlow[],
  nodeTypes: readonly TriageNodeType[],
): FlatGraph | undefined {
  const byId = new Map(flows.map(flow => [flow.id, flow]))
  const types = new Map(nodeTypes.map(type => [type.type, type]))
  const order = flowIdsOf(task, flows).filter(id => byId.has(id))
  const primary = order[0]
  if (primary === undefined) return undefined

  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  /** 扁平 id → 原来的节点，用来给父节点找子图入口。 */
  const flatOf = new Map<string, string>()
  const canvasOf = new Map<string, { nodes: CanvasNode[]; edges: CanvasEdge[] }>()
  for (const id of order) {
    const flow = byId.get(id) as TriageFlow
    canvasOf.set(id, toCanvas(flow, types, byId))
  }

  const mainCanvas = canvasOf.get(primary) as { nodes: CanvasNode[]; edges: CanvasEdge[] }
  const mainBounds = boundsOf(mainCanvas.nodes)
  let cursorY = 0
  for (const id of order) {
    const canvas = canvasOf.get(id) as { nodes: CanvasNode[]; edges: CanvasEdge[] }
    const scope: FlowScope = { id, primary: id === primary }
    const dx = id === primary ? 0 : mainBounds.width + GAP_X
    const dy = id === primary ? 0 : cursorY
    for (const node of canvas.nodes) {
      const flat = flatIdOf(id, node.id)
      flatOf.set(`${id}#${node.id}`, flat)
      const mark = markIn(task, scope, node.id)
      nodes.push({
        ...node,
        id: flat,
        x: node.x + dx,
        y: node.y + dy,
        // `idle` 不进画布：undefined 才是不画圆点。
        ...(mark === 'idle' ? {} : { state: mark }),
      })
    }
    for (const edge of canvas.edges) {
      // 整条路径发光：线继承源节点的处境。先存成变量，条件展开才收得住类型。
      const state = edgeStateOf(task, scope, edge.from)
      edges.push({
        ...edge,
        id: flatIdOf(id, edge.id),
        from: flatOf.get(`${id}#${edge.from}`) ?? edge.from,
        to: flatOf.get(`${id}#${edge.to}`) ?? edge.to,
        ...(state === undefined ? {} : { state }),
      })
    }
    if (id !== primary) cursorY += boundsOf(canvas.nodes).height + GAP_Y
  }

  // 桥：父图里点了哪个 workflow 节点，就把它连到子流程入口上。
  for (const id of order) {
    if (id === primary) continue
    const flow = byId.get(id) as TriageFlow
    // 子图 id 形如 `parent/body`：取斜杠前那截当父图，父图不在场才退回主图。
    const slash = flow.id.lastIndexOf('/')
    const guessed = slash < 0 ? undefined : flow.id.slice(0, slash)
    const parent = guessed !== undefined && canvasOf.has(guessed) ? guessed : primary
    const parentFlow = byId.get(parent) as TriageFlow
    const host = parentFlow.nodes.find(node => String(node.config?.workflow ?? '') === id
      || String(node.config?.workflowId ?? '') === id)
    const from = host === undefined ? undefined : flatOf.get(`${parent}#${host.id}`)
    const entry = entryOf([...((canvasOf.get(id) as { nodes: CanvasNode[] }).nodes)])
    const to = entry === undefined ? undefined : flatOf.get(`${id}#${entry.id}`)
    if (from === undefined || to === undefined) continue
    edges.push({ id: `bridge#${from}->${to}`, from, to, label: flow.name, mode: 'fork' })
  }

  return { nodes, edges, primary }
}

/** 一条边走过没有：为了让整条路径发光，得把节点状态搬到边上。 */
function edgeStateOf(task: Task, scope: FlowScope, nodeId: string): 'ok' | 'failed' | 'running' | undefined {
  const mark = markIn(task, scope, nodeId)
  if (mark === 'ok' || mark === 'failed' || mark === 'running') return mark
  return undefined
}

/** 选中某一格之后要看的定义（参数在定义里，不在记录里）。 */
export interface NodeDefinition {
  readonly flowId: string
  readonly flowName: string
  readonly label: string
  readonly config: Readonly<Record<string, unknown>> | undefined
}

/** 扁平 id → 定义与所在图。图被删了就是 `undefined`。 */
export function definitionOf(flows: readonly TriageFlow[], flatId: string): NodeDefinition | undefined {
  const { flowId, nodeId } = splitFlatId(flatId)
  const flow = flows.find(item => item.id === flowId)
  if (flow === undefined) return undefined
  const node = flow.nodes.find(item => item.id === nodeId)
  return { flowId, flowName: flow.name, label: node?.label ?? nodeId, config: node?.config }
}

/** 节点配置展开成「实际参数」的结果。 */
export interface ResolvedParams {
  readonly actual: Readonly<Record<string, unknown>>
  /** 展开时没找到的变量名（去重）。界面据此提示「按当前变量展开」。 */
  readonly missing: readonly string[]
}

const PLACEHOLDER = /\{([^{}]+)\}/g

/**
 * 把节点配置里的 `{变量}` 换成这次执行的实际值。
 *
 * 变量表是任务级的 `vars`，节点跑的时候引擎就是这么展开的——所以在节点卡片里
 * 显示「实际参数」才对得上当时的行为。**已知偏差**：`vars` 是活的那一份，同名
 * 变量被后面的节点改写后，这里展开的是新值；要逐时刻精确得给记录补 `data.input`。
 * 找不到的变量原样保留，并记进 `missing`。
 */
export function resolveParams(
  config: Readonly<Record<string, unknown>> | undefined,
  vars: Readonly<Record<string, string>> | undefined,
): ResolvedParams {
  const missing: string[] = []
  const substitute = (text: string): string => text.replace(PLACEHOLDER, (whole, raw: string) => {
    const name = raw.trim()
    const value = vars?.[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return substitute(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
    }
    return value
  }
  const actual = (config === undefined ? {} : walk(config)) as Record<string, unknown>
  return { actual, missing }
}

/** 两条记录之间的耗时；有一头是 0（补出来的 `ready` 占位）就没有。 */
export function spentBetween(from: string, to: string | undefined): string | undefined {
  if (to === undefined) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  const ms = end - start
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
