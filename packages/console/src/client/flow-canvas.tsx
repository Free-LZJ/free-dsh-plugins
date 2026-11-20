/**
 * 流程画布：用 React Flow 渲染节点与连线。
 *
 * **为什么用它**：端口拖拽连线、小地图、控制条、框选、缩放平移这套交互，自己写要
 * 几千行还容易出错，而且这些是成熟库打磨过的地方。节点外观仍然完全自定义——信息
 * 密度（参数、条件）是这块真正的价值，不交给库的默认样式。
 *
 * **样式怎么来的**：浏览器半边的产物只有 `client.js`，没有独立样式文件、也不走
 * Vite 的 CSS 图，所以 React Flow 的样式内联成字符串（`flow-styles.ts`）运行时注入。
 *
 * @module @free-dsh-plugins/dsh-console/client/flow-canvas
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getStraightPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import type { Connection, Edge, EdgeProps, EdgeTypes, Node, NodeProps, NodeTypes } from '@xyflow/react'
import { REACT_FLOW_CSS } from './flow-styles.ts'
import { pathOf, routeEdges } from './flow-route.ts'
import type { RoutePoint } from './flow-route.ts'
import { useSurface } from './theme.ts'

/** 一格（或一条线）此刻的处境。 */
export type FlowState = 'ok' | 'failed' | 'suspended' | 'running' | 'next'

/** 画布上的一格。 */
export interface CanvasNode {
  readonly id: string
  readonly type: string
  readonly label: string
  /** 卡片上补充的说明行（参数摘要）。 */
  readonly detail?: readonly string[]
  /** `trigger` | `control` | `action`。 */
  readonly group: string
  /** 会不会改外部世界；有副作用的节点带一道竖条。 */
  readonly sideEffect: boolean
  readonly x: number
  readonly y: number
  readonly enabled: boolean
  /**
   * 这一格此刻的处境；没跑过、也不在本次路径上就是 undefined。
   *
   * `next` = 引擎已经排好、还没轮到它：看板上要能提前看出「下一步是这儿」。
   */
  readonly state?: FlowState
}
/** 一条连线。 */
export interface CanvasEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  /** 边上写的条件摘要；无条件为空。 */
  readonly label?: string
  readonly mode?: 'fork'
  /** 这条边本次被走过了：整条路径发光，全靠它。 */
  readonly state?: FlowState
}

/**
 * 节点卡片尺寸：**必须与 `@free-lzj/dsh-decision` 的 `NODE_SIZE` 一致**。
 *
 * 布局按那个数算间距、这里按这个数画卡片；对不上就会出现「排得整整齐齐但卡片互相
 * 压着」。两个包不能互相取值——浏览器半边一旦 import 决策包，Node 的 `process` /
 * `buffer` 就被拖进产物里，产物契约测试会当场拒收——所以这里抄一份，并由
 * `tests/flow-canvas.client.spec.tsx` 钉住两边相等。
 */
export const NODE_WIDTH = 280
export const NODE_HEIGHT = 104

/** 一类节点的配色。 */
interface NodeLook {
  readonly border: string
  readonly background: string
  readonly accent?: string | undefined
}

/** 分组 → 配色。用主题里的语义色，深色模式跟着走。 */
function lookOf(group: string, sideEffect: boolean): NodeLook {
  const accent = sideEffect ? 'var(--dsw-alias-state-warn-primary)' : undefined
  if (group === 'trigger') {
    return {
      border: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, var(--dsw-alias-bg-layer-1))',
      accent,
    }
  }
  if (group === 'control') {
    return {
      border: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, var(--dsw-alias-bg-layer-1))',
      accent,
    }
  }
  return {
    border: 'var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-layer-1)',
    accent,
  }
}

/** 执行状态 → 小圆点的颜色。 */
function stateColor(state: FlowState): string {
  if (state === 'ok') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'failed') return 'var(--dsw-alias-state-error-primary)'
  if (state === 'running') return 'var(--dsw-alias-state-business-primary)'
  if (state === 'next') return 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)'
  return 'var(--dsw-alias-state-warn-primary)'
}

/**
 * 卡片自己的样式：主要是**连线端点**。
 *
 * React Flow 默认把端点做成 6px、`pointer-events: none` 的小点，再被卡片自己的
 * `overflow: hidden` 裁掉一半；这个插件以前更是直接给它们 `opacity: 0`——于是
 * 「从 A 拖一条线到 B」这件事在画布上根本没有下手的地方，只能绕到右侧属性面板里用
 * 下拉框改。端点必须看得见、摸得到。
 */
const CARD_CSS = `
.dsh-flow-card .react-flow__handle {
  width: 14px;
  height: 14px;
  min-width: 0;
  min-height: 0;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  /* 默认是 none，光看得见也拖不动。 */
  pointer-events: all;
  cursor: crosshair;
  /* 拖动时不用瞄准：视觉 14px，但外面套一圈透明缓冲把可点范围撑到 24px。
     9px 的圆点在大屏上要精准命中，拖一次线像在打靶。 */
  box-sizing: content-box;
  padding: 5px;
  margin: -5px;
  background-clip: content-box;
}
/* 贴着卡片内沿摆，才不会被 overflow 裁成半个月牙。 */
.dsh-flow-card .react-flow__handle-top { top: 4px; transform: translate(-50%, 0); }
.dsh-flow-card .react-flow__handle-bottom { bottom: 4px; transform: translate(-50%, 0); }
/* 正在跑的方块呼吸：静态蓝点在一屏十几张卡里看不出「就是它还在动」。 */
@keyframes dsh-flow-running {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(1.6); }
}
.dsh-flow-card[data-state="running"] .dsh-flow-dot {
  animation: dsh-flow-running 1.1s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-flow-card[data-state="running"] .dsh-flow-dot { animation: none; }
}
/* 走过的路径整条亮起来。这是这张图的主要读法：不是看单个绿点，而是看「从哪儿走到哪儿」。 */
.dsh-flow-card { box-shadow: var(--dsw-elevation-soft); }
.dsh-flow-card[data-selected="true"][data-state="none"] {
  box-shadow: 0 0 0 1.5px var(--dsw-alias-state-business-primary);
}
.dsh-flow-card[data-state="ok"] { --dsh-glow: var(--dsw-alias-state-success-primary); }
.dsh-flow-card[data-state="failed"] { --dsh-glow: var(--dsw-alias-state-error-primary); }
.dsh-flow-card[data-state="running"] { --dsh-glow: var(--dsw-alias-state-business-primary); }
.dsh-flow-card[data-state="suspended"] { --dsh-glow: var(--dsw-alias-state-warn-primary); }
.dsh-flow-card[data-state="next"] { --dsh-glow: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }
/* 深色背景吃**宽而柔的光晕**（大扩散、低透明度），浅色背景吃**紧描边 + 短投影**。
   一套配方喂两个背景：深色上像块脏斑，浅色上根本看不见。 */
.dsh-flow-surface[data-surface="dark"] .dsh-flow-card[data-state]:not([data-state="none"]) {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsh-glow) 58%, transparent),
    0 0 26px 2px color-mix(in srgb, var(--dsh-glow) 30%, transparent);
}
.dsh-flow-surface[data-surface="light"] .dsh-flow-card[data-state]:not([data-state="none"]) {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--dsh-glow) 72%, transparent),
    0 8px 18px -8px color-mix(in srgb, var(--dsh-glow) 68%, transparent);
}
/* 「下一步」还只是个预告，别跟走过的格子一个亮度。 */
.dsh-flow-surface[data-surface="dark"] .dsh-flow-card[data-state="next"] {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsh-glow) 40%, transparent);
}
.dsh-flow-surface[data-surface="light"] .dsh-flow-card[data-state="next"] {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--dsh-glow) 42%, transparent);
}
.dsh-flow-card[data-selected="true"] {
  outline: 1.5px solid var(--dsw-alias-state-business-primary);
  outline-offset: 0;
}
/* 连线跟着走：走过的线段加一点外发光，深色背景才看得出来。 */
.dsh-flow-surface[data-surface="dark"] .dsh-edge--ok .react-flow__edge-path,
.dsh-flow-surface[data-surface="dark"] .dsh-edge--failed .react-flow__edge-path,
.dsh-flow-surface[data-surface="dark"] .dsh-edge--running .react-flow__edge-path {
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--dsh-glow) 60%, transparent));
}
.dsh-edge--ok { --dsh-glow: var(--dsw-alias-state-success-primary); }
.dsh-edge--failed { --dsh-glow: var(--dsw-alias-state-error-primary); }
.dsh-edge--running { --dsh-glow: var(--dsw-alias-state-business-primary); }
/* 标签压在正交线上会盖住拐角，给个坐底。 */
.dsh-flow-surface .react-flow__edge-textbg { fill: var(--dsw-alias-bg-layer-1); fill-opacity: 0.85; }
.dsh-flow-surface .react-flow__edge-text { fill: var(--dsw-alias-label-tertiary); font-size: 10px; }
/* 缩放条跟着背景走：库只在 .react-flow.dark 下换色，而我们靠 data-surface。 */
.dsh-flow-surface[data-surface="dark"] .react-flow__controls-button {
  background: var(--dsw-alias-bg-layer-2);
  border-bottom-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  fill: var(--dsw-alias-label-secondary);
}
.dsh-flow-surface[data-surface="dark"] .react-flow__controls-button:hover {
  background: var(--dsw-alias-bg-layer-3);
}
/* 鼠标在哪张卡上、或者正在拉线，端点就亮起来。 */
.dsh-flow-card:hover .react-flow__handle,
.dsh-flow-card:focus-within .react-flow__handle,
.dsh-flow-card .react-flow__handle.connectingfrom,
.dsh-flow-card .react-flow__handle.connectingto {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-3);
}
`

/** 节点卡片。信息全在这里，不用点开才知道它在干什么。 */
function FlowNodeCard({ data, selected }: NodeProps): ReactNode {
  const node = data as unknown as CanvasNode
  const look = lookOf(node.group, node.sideEffect)
  return (
    <div
      className="dsh-flow-card"
      data-state={node.state ?? 'none'}
      data-selected={selected === true ? 'true' : 'false'}
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        padding: '8px 12px',
        borderRadius: 'var(--dsw-radius-lg)',
        border: `0.5px solid ${look.border}`,
        background: look.background,
        // 阴影（层级阴影 / 执行发光 / 选中环）全在 CARD_CSS 里按 data-* 选：
        // 内联样式会盖掉样式表，而「走到哪」的发光必须能覆盖掉默认阴影。
        opacity: node.enabled ? 1 : 0.5,
        position: 'relative',
        overflow: 'hidden',
        cursor: 'grab',
      }}
    >
      {look.accent === undefined ? null : (
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: look.accent }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {node.state === undefined ? null : (
          <span
            className='dsh-flow-dot'
            title={node.state === 'running' ? '正在跑' : node.state === 'next' ? '下一步' : undefined}
            style={{ width: 6, height: 6, borderRadius: 3, flex: 'none', background: stateColor(node.state) }}
          />
        )}
        <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {node.label}
        </span>
        <span style={{ fontSize: 10, lineHeight: '14px', padding: '1px 5px', borderRadius: 'var(--dsw-radius-sm)', flex: 'none', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-tertiary)' }}>
          {node.type}
        </span>
      </div>
      {(node.detail ?? []).slice(0, 2).map((line, index) => (
        <span
          key={String(index)}
          style={{ fontSize: 11, lineHeight: '15px', color: index === 0 ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {line}
        </span>
      ))}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const NODE_TYPES = { card: FlowNodeCard } as unknown as NodeTypes

/** 按长度取折线中点：标签摆这儿，正好落在最长那段的中间，不压拐角。 */
function midpointOf(points: readonly RoutePoint[]): { x: number; y: number } {
  const head = points[0] as RoutePoint
  const tail = points[points.length - 1] as RoutePoint
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1] as RoutePoint
    const point = points[index] as RoutePoint
    total += Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y)
  }
  let walked = 0
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1] as RoutePoint
    const point = points[index] as RoutePoint
    const length = Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y)
    if (walked + length >= total / 2) {
      const ratio = length === 0 ? 0 : (total / 2 - walked) / length
      return { x: prev.x + (point.x - prev.x) * ratio, y: prev.y + (point.y - prev.y) * ratio }
    }
    walked += length
  }
  return { x: (head.x + tail.x) / 2, y: (head.y + tail.y) / 2 }
}

/**
 * 连线本体：画 `routeEdges` 算出来的折线。
 *
 * 用 `BaseEdge` 而不是自己拼 `<path>`：标签、交互宽度、选中态都由库兜住；自己拼过一次，
 * 结果连线上的条件文字全丢了。折线没用算出来（极端拥挤）才退回直线。
 */
function RoutedEdge(props: EdgeProps): ReactNode {
  const points = ((props.data ?? {}) as { points?: readonly RoutePoint[] }).points ?? []
  // 这个版本的 getStraightPath 返回元组 [path, labelX, labelY, offsetX, offsetY]。
  const [straightPath, straightLabelX, straightLabelY] = getStraightPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
  })
  const path = points.length >= 2 ? pathOf(points) : straightPath
  const mid = points.length >= 2 ? midpointOf(points) : { x: straightLabelX, y: straightLabelY }
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      label={props.label}
      labelX={mid.x}
      labelY={mid.y}
      interactionWidth={16}
    />
  )
}

const EDGE_TYPES = { routed: RoutedEdge } as unknown as EdgeTypes

/** 边的颜色：走过的线按结局上色，没走过的保持低调。 */
function edgeStyle(state: FlowState | undefined, highlighted: boolean, dash: boolean): CSSProperties {
  const width = highlighted || state === 'running' ? 2.2 : 1.6
  const stroke = state === 'ok'
    ? 'var(--dsw-alias-state-success-primary)'
    : state === 'failed'
      ? 'var(--dsw-alias-state-error-primary)'
      : state === 'running' || highlighted
        ? 'var(--dsw-alias-state-business-primary)'
        : 'var(--dsw-alias-border-l3)'
  return {
    stroke,
    strokeWidth: width,
    ...(state === 'running' ? { strokeDasharray: '6 4' } : dash ? { strokeDasharray: '5 4' } : {}),
  }
}

/** 画布的属性。 */
export interface FlowCanvasProps {
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
  readonly selected?: string | undefined
  readonly onSelect?: (id: string | undefined) => void
  /** 拖动结束后交出完整的新坐标；不传表示这一版不允许拖。 */
  readonly onMove?: (id: string, x: number, y: number) => void
  /** 双击节点（下钻 / 打开属性）。 */
  readonly onOpen?: (id: string) => void
  /** 拖出一条新连线。 */
  readonly onConnect?: (from: string, to: string) => void
  /** 点中一条连线（选中它去改条件）。 */
  readonly onEdgeClick?: (edgeId: string) => void
  /** 试跑说要走的那条边：点亮它，一行文字说不清是哪根线。 */
  readonly highlightEdge?: string | undefined
  /** 撑满容器（全屏时用）。 */
  readonly fullscreen?: boolean
  /**
   * 画布高度（全屏时忽略）。
   *
   * 不写死成一个常数：面板本身比窗口矮一个标题栏，而且画布上面还有工具栏。写死就会
   * 出现「画布 640 高、可用空间只有 566」——底部连缩放条带小地图一起被窗口切掉，
   * 页面又不可滚动，只能靠拖拽硬凑。
   */
  readonly height?: number
  /**
   * 「这个视口该重新框一次」的令牌：换图、自动布局之后都必须换一个新的。
   *
   * 没有它，React Flow 只在挂载时 fitView 一次——切到一张 2 个节点的子工作流，
   * 看到的还是上一张大图的缩放比，图缩成角落里的一小撮；自动布局换了走向之后
   * 更是整张图跑到视口外面，等于点了没反应。
   */
  readonly fitToken?: string
  /**
   * 框选的可读下限（默认 `READABLE_ZOOM`）。
   *
   * 定义页要「缩到文字还认得出」，所以默认 0.7；看板的执行图是**看全貌**用的——
   * 扁平图（主图 + 子流程）动辄 2900 宽，0.7 只用得上视口中间那一条，左右两侧
   * 直接被切到负坐标去。那里传 `OVERVIEW_ZOOM`。
   */
  readonly minZoom?: number
}

/**
 * 画布要不要重建：把**会改变画面的每一件事**都编进去。
 *
 * 坐标必须在内。曾经漏了它，于是自动布局把 14 个节点的新坐标写进文件、页面也重新
 * 读了一遍，但这里判定「数据没变」直接 return，图一个像素都不动——按钮看着像坏的。
 * @param nodes - 要画的节点。
 * @param edges - 要画的连线。
 * @returns 一份稳定的摘要。
 */
export function canvasSignature(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], highlight?: string): string {
  return JSON.stringify({
    nodes: nodes.map(node => [
      node.id, node.label, node.type, node.detail ?? [], node.enabled, node.state ?? '',
      node.group, node.sideEffect, node.x, node.y,
    ]),
    edges: edges.map(edge => [edge.id, edge.from, edge.to, edge.label ?? '', edge.mode ?? '', edge.state ?? '']),
    // 点亮哪条边也算画布状态：不进签名的话，试跑改结论时边上的高亮不会重画。
    highlight: highlight ?? '',
  })
}

/** 画布本体。外面套一层 Provider，因为 React Flow 的 hook 需要它。 */
export function FlowCanvas(props: FlowCanvasProps): ReactNode {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

/** 样式只注入一次：多个画布实例共用一份。 */
function useFlowStyles(): void {
  useEffect(() => {
    const sheets: readonly { id: string; css: string }[] = [
      { id: 'dsh-react-flow-css', css: REACT_FLOW_CSS },
      { id: 'dsh-flow-card-css', css: CARD_CSS },
    ]
    for (const sheet of sheets) {
      if (document.getElementById(sheet.id) !== null) continue
      const element = document.createElement('style')
      element.id = sheet.id
      element.textContent = sheet.css
      document.head.appendChild(element)
    }
  }, [])
}

/** 视口四周留多少空（按容器尺寸的比例，两侧各一份）。 */
const FIT_PADDING = 0.16
/**
 * 框选的**可读下限**。
 *
 * `fitView` 的职责是「整张图都进视口」，代价随图变宽指数上升：`mail-new` 是
 * `触发 → 分支(11 条并列出边) → 11 个工作流 → 结束`，模型包围盒 3623×608，塞进
 * 1440×508 的画布后 zoom 只有 **0.341**——卡片被压到 96px、13px 的标题实际只有
 * 4.4px，打开编排页第一眼就是一张读不出字的缩略图。这是「流程编排几乎不可用」
 * 最直接的来源，也是用户第一次点进来就放弃的原因。
 *
 * 所以框选到「文字还能读」为止：0.7 时卡片 196px、标题 9.1px、说明行 7.7px，
 * 标题和节点类型都还认得出；剩下的靠拖动画布、右下小地图和「点节点看右侧配置」
 * 浏览。手动缩放不受这个下限限制（`minZoom≈0.15`），想看全图随时可以缩。
 */
export const READABLE_ZOOM = 0.7
/** 「一眼看全整张扁平图」的下限：看板执行图用这个。 */
export const OVERVIEW_ZOOM = 0.2
/** 放大上限：图再小也别放大到糊屏。 */
const FIT_MAX_ZOOM = 1
/** 一次框选的上下限。下限可传，因为「可读」和「看全」是两种诉求。 */
const fitLimitsOf = (minZoom: number): { minZoom: number; maxZoom: number } => ({ minZoom, maxZoom: FIT_MAX_ZOOM })

function FlowCanvasInner(props: FlowCanvasProps): ReactNode {
  const { nodes: sourceNodes, edges: sourceEdges, selected, onSelect, onMove, onOpen, onConnect, onEdgeClick, fullscreen, height, fitToken } = props
  useFlowStyles()
  /** 画布底下是深色还是浅色：发光配方两套，判断靠量一次背景色。 */
  const surface = useSurface()

  /** React Flow 自己管节点位置；外部数据变了才重建。 */
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([])
  const [flowEdges, setFlowEdges] = useEdgesState<Edge>([])
  const { fitView, getNodes, getZoom } = useReactFlow()
  /** 这一次框选的上下限：看板要「看全」，定义页要「可读」。 */
  const limits = useMemo(() => fitLimitsOf(props.minZoom ?? READABLE_ZOOM), [props.minZoom])
  /** 画布容器，用来盯住它自己的尺寸变化。 */
  const shell = useRef<HTMLDivElement | null>(null)
  /**
   * 这次框选是不是「顶到了可读下限」。
   *
   * 顶到就说明**整张图并没有全进视口**，两侧被切掉的部分要靠拖动或小地图才能看到。
   * 不说一声的话，用户会以为图被裁坏了——所以画布左下角给一句提示。
   */
  const [clamped, setClamped] = useState(false)

  const signature = useMemo(() => canvasSignature(sourceNodes, sourceEdges, props.highlightEdge), [sourceNodes, sourceEdges, props.highlightEdge])
  const lastSignature = useRef('')

  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    /**
     * **按 id 复用旧节点对象，只改它的坐标与数据。**
     *
     * 每次整批新建对象的话，React Flow 会把它们当成没量过的新节点，`measured` 清空、
     * 重新测量一遍——画面闪一下，而且这中间 `fitView` 算不出边界，自动布局之后
     * 「视口重新框一次」会静默失败。
     */
    setFlowNodes(prev => {
      const known = new Map(prev.map(node => [node.id, node]))
      return sourceNodes.map(node => {
        const existing = known.get(node.id)
        return {
          ...(existing ?? { id: node.id, type: 'card' }),
          id: node.id,
          type: existing?.type ?? 'card',
          position: { x: node.x, y: node.y },
          data: node as unknown as Record<string, unknown>,
          selected: node.id === selected,
        }
      })
    })
    /** 连线走正交折线：先一次算好所有走廊，再画。 */
    const routes = routeEdges(sourceNodes, sourceEdges)
    setFlowEdges(sourceEdges.map(edge => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'routed',
      // 正在流的边跑虚线动画：静态像素看不出「东西正从这儿过」。
      animated: edge.state === 'running' || edge.id === props.highlightEdge,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      className: `dsh-edge${edge.state === undefined ? '' : ` dsh-edge--${edge.state}`}`,
      data: { points: routes.get(edge.id) ?? [] },
      style: edgeStyle(edge.state, edge.id === props.highlightEdge, edge.mode === 'fork'),
    })))
  }, [signature, sourceNodes, sourceEdges, selected, setFlowNodes, setFlowEdges])

  /** 选中态跟着外部走（外部可能从属性面板反过来清掉选中）。 */
  useEffect(() => {
    setFlowNodes(prev => prev.map(node => (node.selected === (node.id === selected) ? node : { ...node, selected: node.id === selected })))
  }, [selected, setFlowNodes])

  /**
   * 视口重新框一次。
   *
   * 两个坑都要避：
   * 1. **等节点量完**。`fitView` 在节点还没 `measured` 时算不出边界，会直接什么也不做——
   *    看起来就是「点了自动布局，图跑到视口外面去了」。
   * 2. **等坐标进了 store**。`setFlowNodes` 是异步的，同一帧里 fit 量到的还是旧位置。
   *
   * 所以按帧重试，直到节点都量出来再框；最多等 8 帧，等不到就按现有信息框一次。
   */
  const lastFit = useRef('')
  /**
   * `fitView` / `getNodes` 每次渲染都可能是新函数。
   *
   * 以前把它们放进 effect 的依赖里，于是 effect 跟着每次渲染重跑，cleanup 把上一条
   * 「等三帧再框」的 rAF 链掐掉——重跑比三帧快，结果**这条链一次也没能走到底**，
   * `fitView` 从来没被真正调用过（探针一条日志都没有）。用 ref 钉住函数身份，
   * 依赖只留 `fitToken` / `fullscreen` 这两个真正该触发重框的值。
   */
  const fitViewRef = useRef(fitView)
  fitViewRef.current = fitView
  const getNodesRef = useRef(getNodes)
  getNodesRef.current = getNodes
  const getZoomRef = useRef(getZoom)
  getZoomRef.current = getZoom
  /**
   * 框一次，并记下这次有没有顶到可读下限。
   *
   * `fitView()` 返回 `Promise<boolean>`：没有节点可框时是 `false`，不动视口。
   * 框完立刻读 zoom，等于 `READABLE_ZOOM` 就说明被下限钳住了（图比视口大）。
   */
  const refit = useCallback((): void => {
    void fitViewRef.current({ padding: FIT_PADDING, ...limits }).then((ok) => {
      if (!ok) return
      setClamped(getNodesRef.current().length > 0 && getZoomRef.current() <= limits.minZoom + 0.001)
    })
  }, [limits])
  useEffect(() => {
    const base = fitToken ?? ''
    /**
     * 全屏 / 退出全屏也算一次「该重框」。
     *
     * 它只改容器尺寸，不改 `fitToken`，所以以前走的是下面 `ResizeObserver` 那条路；
     * 那条路**不等节点量完**就直接 `fitView()`，而全屏那一瞬间节点正在按新宽度重排，
     * `fitView` 算不出边界就静默什么也不做——结果整张图停在 `matrix(1,0,0,1,0,0)`，
     * 也就是「按了全屏，画布变大了，但图还是原来那个角度，右边照样被切掉」。
     * 把它并进这个令牌，就能复用「按帧等到 measured 再框」那套逻辑。
     */
    const token = base === '' ? '' : `${base}#${fullscreen === true ? 'full' : 'window'}`
    if (token === '') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    /**
     * 等节点量出来的**时间**预算（不是帧数）。
     *
     * 早先这里是「最多 12 帧（≈190ms），等不到就按现状框一次」：自动布局之后画布按
     * `fitTick` 重建，14 个节点要重新量，量完往往晚于 190ms——于是那一次框选拿到的是
     * 一堆没有 `measured` 的节点，`fitView` 算不出边界，直接被 `maxZoom` 钳成
     * `zoom=1`、横向偏移 490px，**自动布局一按，图就跳成一个只看得见几块的近景**。
     * 现在改成按时间等（3 秒封顶），量完再框；超时也框一次，但不把这次算作「已经框过」，
     * 后面 `ResizeObserver` / 下一次 `fitToken` 变化还能再框。
     */
    const deadline = Date.now() + 3000
    const attempt = (): void => {
      if (cancelled || lastFit.current === token) return
      attempts += 1
      const nodes = getNodesRef.current()
      const ready = nodes.length > 0 && nodes.every(node => node.measured?.width !== undefined)
      /**
       * **最少让两拍**，哪怕节点都已经量过。
       *
       * 容器刚换尺寸（换图、全屏）时，DOM 已经更新，但 React Flow 自己那份宽高要等它内部
       * 的 ResizeObserver 回调后才更新。这时候调 `fitView`，它拿旧宽高算边界，算出个
       * 0 尺寸，再被 `FIT_LIMITS.maxZoom` 钳成 `zoom=1`、平移 0——就成了
       * `matrix(1,0,0,1,0,0)`，看起来正是「框了个寂寞，图还在外面」。
       *
       * **用 `setTimeout` 而不是 `requestAnimationFrame`**：rAF 在标签页不可见时被浏览器
       * 整个暂停（`document.hidden === true` 时实测回调 0 次），而「切走再切回来」正是
       * 最需要重框的时候。`setTimeout` 在后台仍会跑，只是被节流到约 1 秒——慢，但不会
       * 像 rAF 那样干脆不执行。
       */
      if ((!ready || attempts < 3) && Date.now() < deadline) {
        timer = setTimeout(attempt, 16)
        return
      }
      if (!ready) {
        // 超时了还没量完：框一次尽量别留白，但**不钉** lastFit，留给下一次机会。
        refit()
        return
      }
      lastFit.current = token
      refit()
    }
    timer = setTimeout(attempt, 0)
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
  }, [fitToken, fullscreen, refit])

  /**
   * 容器**自己**变宽变窄了，也要重框。
   *
   * 之前只盯「数据变了」：拖窗口大小、面板被挤窄——尺寸变了但图没变，于是变换还是按
   * 旧宽度算的，图就偏在一边（左边留 100px、右边负 275px，也就是右边直接被切掉），
   * 看着像「边距没处理好」。尺寸变了就按新尺寸重框，构图永远正。
   */
  useEffect(() => {
    const element = shell.current
    if (element === null) return
    let lastWidth = element.clientWidth
    let lastHeight = element.clientHeight
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      refit()
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [refit])

  const handleDragStop = useCallback((_event: unknown, node: Node) => {
    onMove?.(node.id, Math.round(node.position.x), Math.round(node.position.y))
  }, [onMove])

  const handleConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return
    onConnect?.(connection.source, connection.target)
  }, [onConnect])

  return (
    <div
      ref={shell}
      className="dsh-flow-surface"
      data-surface={surface}
      style={{ width: '100%', height: fullscreen ? '100%' : (height ?? 640), minHeight: 320, position: 'relative' }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleDragStop}
        onNodeClick={(_event, node) => { onSelect?.(node.id) }}
        onNodeDoubleClick={(_event, node) => { onOpen?.(node.id) }}
        onPaneClick={() => { onSelect?.(undefined) }}
        onConnect={handleConnect}
        onEdgeClick={(_event, edge) => { onEdgeClick?.(edge.id) }}
        fitView
        /**
         * 上限钉在 1：只有两个节点的子工作流不该被放大到糊满一屏——卡片放到原始大小、
         * 居中摆好就够了。`maxZoom` 必须写在这里而不是只写进代码里的那次 `fitView()`：
         * 换图之后 React Flow 自己也会重新框一次，它只读这里的选项。
         */
        fitViewOptions={{ padding: FIT_PADDING, ...limits }}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        <Background gap={16} size={1} color="var(--dsw-alias-border-l2)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(node) => {
            const group = (node.data as unknown as CanvasNode | undefined)?.group
            if (group === 'trigger') return 'var(--dsw-alias-state-business-primary)'
            if (group === 'control') return 'var(--dsw-alias-state-warn-primary)'
            return 'var(--dsw-alias-border-l3)'
          }}
          style={{ background: 'var(--dsw-alias-bg-layer-1)' }}
          maskColor="color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent)"
        />
      </ReactFlow>
      {clamped
        ? (
          <div
            style={{
              position: 'absolute',
              left: 12,
              top: 12,
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 'calc(100% - 120px)',
              padding: '4px 10px',
              borderRadius: 'var(--dsw-radius-sm)',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 11,
              lineHeight: '16px',
              pointerEvents: 'none',
            }}
          >
            图比视口大，已按可读比例显示 · 拖动画布，或用右下角小地图、左下角 − 看全图
          </div>
        )
        : null}
    </div>
  )
}

/** 画布容器的外框样式（全屏时撑满）。 */
export const canvasFrameStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 'var(--dsw-radius-md)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-1)',
}
