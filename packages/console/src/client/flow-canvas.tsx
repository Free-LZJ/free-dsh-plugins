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

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import type { Connection, Edge, Node, NodeProps, NodeTypes } from '@xyflow/react'
import { REACT_FLOW_CSS } from './flow-styles.ts'

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
  /** 这一格最近一次执行的结果；没跑过就是 undefined。 */
  readonly state?: 'ok' | 'failed' | 'suspended'
}
/** 一条连线。 */
export interface CanvasEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  /** 边上写的条件摘要；无条件为空。 */
  readonly label?: string
  readonly mode?: 'fork'
}

/** 节点估算尺寸：布局算法与画布都要用它。 */
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
function stateColor(state: 'ok' | 'failed' | 'suspended'): string {
  if (state === 'ok') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'failed') return 'var(--dsw-alias-state-error-primary)'
  return 'var(--dsw-alias-state-warn-primary)'
}

/** 节点卡片。信息全在这里，不用点开才知道它在干什么。 */
function FlowNodeCard({ data, selected }: NodeProps): ReactNode {
  const node = data as unknown as CanvasNode
  const look = lookOf(node.group, node.sideEffect)
  return (
    <div
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        padding: '8px 12px',
        borderRadius: 10,
        border: `0.5px solid ${look.border}`,
        background: look.background,
        boxShadow: selected ? `0 0 0 1.5px var(--dsw-alias-state-business-primary)` : '0 1px 2px rgba(0,0,0,0.06)',
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
          <span style={{ width: 6, height: 6, borderRadius: 3, flex: 'none', background: stateColor(node.state) }} />
        )}
        <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {node.label}
        </span>
        <span style={{ fontSize: 10, lineHeight: '14px', padding: '1px 5px', borderRadius: 5, flex: 'none', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-tertiary)' }}>
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
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, width: 8, height: 8 }} />
    </div>
  )
}

const NODE_TYPES = { card: FlowNodeCard } as unknown as NodeTypes

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
  /** 撑满容器（全屏时用）。 */
  readonly fullscreen?: boolean
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
    const id = 'dsh-react-flow-css'
    if (document.getElementById(id) !== null) return
    const element = document.createElement('style')
    element.id = id
    element.textContent = REACT_FLOW_CSS
    document.head.appendChild(element)
  }, [])
}

function FlowCanvasInner(props: FlowCanvasProps): ReactNode {
  const { nodes: sourceNodes, edges: sourceEdges, selected, onSelect, onMove, onOpen, onConnect, onEdgeClick, fullscreen } = props
  useFlowStyles()

  /** React Flow 自己管节点位置；外部数据变了才重建。 */
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([])
  const [flowEdges, setFlowEdges] = useEdgesState<Edge>([])

  /** 上次交给外面的完整数据，用来判断「是不是真的变了」，避免拖到一半被重建打断。 */
  const signature = useMemo(
    () => JSON.stringify({
      nodes: sourceNodes.map(node => [node.id, node.label, node.type, node.detail ?? [], node.enabled, node.state ?? '']),
      edges: sourceEdges.map(edge => [edge.id, edge.from, edge.to, edge.label ?? '']),
    }),
    [sourceNodes, sourceEdges],
  )
  const lastSignature = useRef('')

  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    setFlowNodes(sourceNodes.map(node => ({
      id: node.id,
      type: 'card',
      position: { x: node.x, y: node.y },
      data: node as unknown as Record<string, unknown>,
      selected: node.id === selected,
    })))
    setFlowEdges(sourceEdges.map(edge => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'default',
      animated: false,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      style: { stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 1.4 },
      ...(edge.mode === 'fork' ? { style: { stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 1.4, strokeDasharray: '5 4' } } : {}),
    })))
  }, [signature, sourceNodes, sourceEdges, selected, setFlowNodes, setFlowEdges])

  /** 选中态跟着外部走（外部可能从属性面板反过来清掉选中）。 */
  useEffect(() => {
    setFlowNodes(prev => prev.map(node => (node.selected === (node.id === selected) ? node : { ...node, selected: node.id === selected })))
  }, [selected, setFlowNodes])

  const handleDragStop = useCallback((_event: unknown, node: Node) => {
    onMove?.(node.id, Math.round(node.position.x), Math.round(node.position.y))
  }, [onMove])

  const handleConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return
    onConnect?.(connection.source, connection.target)
  }, [onConnect])

  return (
    <div style={{ width: '100%', height: fullscreen ? '100%' : 640, minHeight: 320, position: 'relative' }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleDragStop}
        onNodeClick={(_event, node) => { onSelect?.(node.id) }}
        onNodeDoubleClick={(_event, node) => { onOpen?.(node.id) }}
        onPaneClick={() => { onSelect?.(undefined) }}
        onConnect={handleConnect}
        onEdgeClick={(_event, edge) => { onEdgeClick?.(edge.id) }}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.15 }}
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
    </div>
  )
}

/** 画布容器的外框样式（全屏时撑满）。 */
export const canvasFrameStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderRadius: 12,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-1)',
}
