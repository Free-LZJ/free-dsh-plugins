/**
 * 节点图画布。
 *
 * **自己画，不引图库**：CSS 是通过 `styles.ts` 手工注入的（浏览器半边拿不到打包器
 * 生成的样式表），图库带来的那份样式进不来；而我们的图是规整的分层 DAG，节点不转、
 * 边不交叉，几百行 SVG 就够了。
 *
 * 分工：**坐标由 Host 算**（`/rules/flow` 已经带回 `pos`），这里只负责画、拖、选。
 * 拖过之后把新坐标交回去，由保存流程决定写不写盘——渲染信息不该悄悄改文件。
 *
 * @module @free-lzj/dsh-console/client/flow-canvas
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/** 画布上的一个节点。 */
export interface CanvasNode {
  readonly id: string
  readonly type: string
  readonly label: string
  /** `trigger` | `control` | `action`。 */
  readonly group: string
  /** 会不会改外部世界；有副作用的节点带一个记号。 */
  readonly sideEffect: boolean
  readonly x: number
  readonly y: number
  readonly enabled: boolean
  /** 这一格最近一次执行的结果；没有就跑过。 */
  readonly state?: 'ok' | 'failed' | 'suspended'
}

/** 画布上的一条边。 */
export interface CanvasEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  /** 边上写的条件摘要；无条件为空。 */
  readonly label?: string
  readonly mode?: 'fork'
}

/** 画布尺寸常量。 */const NODE_WIDTH = 180
const NODE_HEIGHT = 56
const MIN_SCALE = 0.4
const MAX_SCALE = 1.8

/** 一类节点的颜色。 */
function toneOf(group: string): { bg: string; border: string; fg: string } {
  switch (group) {
    case 'trigger':
      return { bg: 'var(--dsw-alias-fill-tint-brand, #eef4ff)', border: 'var(--dsw-alias-line-brand, #6b8cff)', fg: 'var(--dsw-alias-text-brand, #2a4bd8)' }
    case 'control':
      return { bg: 'var(--dsw-alias-fill-tint-neutral, #f4f5f7)', border: 'var(--dsw-alias-line-strong, #b8bcc7)', fg: 'var(--dsw-alias-text-1, #22242a)' }
    default:
      return { bg: 'var(--dsw-alias-bg-layer, #fff)', border: 'var(--dsw-alias-line, #dfe1e6)', fg: 'var(--dsw-alias-text-1, #22242a)' }
  }
}

/** 执行状态那一点的颜色。 */
function stateColor(state: CanvasNode['state']): string {
  if (state === 'ok') return 'var(--dsw-alias-fill-success, #1aa06d)'
  if (state === 'failed') return 'var(--dsw-alias-fill-danger, #d93f3f)'
  return 'var(--dsw-alias-fill-warning, #d99a1a)'
}

/** 两个节点之间那条曲线。 */
function edgePath(from: CanvasNode, to: CanvasNode): string {
  const x1 = from.x + NODE_WIDTH
  const y1 = from.y + NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + NODE_HEIGHT / 2
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 - dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`
}

/** 画布的属性。 */
export interface FlowCanvasProps {
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
  readonly selected?: string | undefined
  readonly onSelect?: (id: string | undefined) => void
  /** 拖动结束后交出完整的新坐标；不传表示这一版不允许拖。 */
  readonly onMove?: (id: string, x: number, y: number) => void
  /** 双击节点：通常是「打开属性面板」。 */
  readonly onOpen?: (id: string) => void
}

/**
 * 画布。
 * @param props - 节点、边与回调。
 * @returns 可缩放平移的画布。
 */
export function FlowCanvas({ nodes, edges, selected, onSelect, onMove, onOpen }: FlowCanvasProps) {
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | undefined>()
  const [panning, setPanning] = useState<{ x: number; y: number; panX: number; panY: number } | undefined>()
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 已经自动对过焦没有。只做一次：之后人怎么缩放平移都算他的。 */
  const fittedRef = useRef(false)

  /**
   * 把所有节点缩放到视野里。
   *
   * 没有这一步，一张 36 个节点的图打开时只看得见最左边两个——「可视化」就成了摆设。
   * 只在第一次拿到节点时做，之后人的缩放与平移不再被覆盖。
   */
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return
    const host = hostRef.current
    if (host === null) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 50 || rect.height < 50) return

    const padding = 32
    const minX = Math.min(...nodes.map(node => node.x))
    const minY = Math.min(...nodes.map(node => node.y))
    const maxX = Math.max(...nodes.map(node => node.x + NODE_WIDTH))
    const maxY = Math.max(...nodes.map(node => node.y + NODE_HEIGHT))
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const next = Math.min(
      1,
      Math.max(MIN_SCALE, Math.min((rect.width - padding * 2) / spanX, (rect.height - padding * 2) / spanY)),
    )
    setScale(next)
    // 居中：内容比视野小时摆中间，比视野大时从左上的留白开始。
    const offsetX = Math.max(padding, (rect.width - spanX * next) / 2)
    const offsetY = Math.max(padding, (rect.height - spanY * next) / 2)
    setPan({ x: offsetX - minX * next, y: offsetY - minY * next })
    fittedRef.current = true
  }, [nodes])

  const onPointerDownNode = useCallback((event: React.PointerEvent, node: CanvasNode) => {
    if (onMove === undefined) return
    event.stopPropagation()
    const rect = hostRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const x = (event.clientX - rect.left - pan.x) / scale
    const y = (event.clientY - rect.top - pan.y) / scale
    setDragging({ id: node.id, dx: x - node.x, dy: y - node.y, x: node.x, y: node.y })
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }, [onMove, pan, scale])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    if (dragging !== undefined) {
      const x = (event.clientX - rect.left - pan.x) / scale - dragging.dx
      const y = (event.clientY - rect.top - pan.y) / scale - dragging.dy
      setDragging({ ...dragging, x, y })
      return
    }
    if (panning !== undefined) {
      setPan({ x: panning.panX + (event.clientX - panning.x), y: panning.panY + (event.clientY - panning.y) })
    }
  }, [dragging, panning, pan, scale])

  const onPointerUp = useCallback(() => {
    if (dragging !== undefined) {
      onMove?.(dragging.id, Math.round(dragging.x), Math.round(dragging.y))
      setDragging(undefined)
    }
    setPanning(undefined)
  }, [dragging, onMove])

  /** 空白处按下：平移；同时清掉选中。 */
  const onPointerDownCanvas = useCallback((event: React.PointerEvent) => {
    onSelect?.(undefined)
    setPanning({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y })
  }, [onSelect, pan])

  /** 滚轮缩放；按住 ctrl 时以指针为中心。 */
  const onWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (event.deltaY > 0 ? 0.92 : 1.08)))
    setScale(next)
  }, [scale])

  /** 拖动中的位置优先于存下来的位置。 */
  const placed = useMemo(() => nodes.map(node => (
    dragging?.id === node.id ? { ...node, x: dragging.x, y: dragging.y } : node
  )), [nodes, dragging])

  const placedById = useMemo(() => {
    const map = new Map<string, CanvasNode>()
    for (const node of placed) map.set(node.id, node)
    return map
  }, [placed])

  const width = Math.max(1200, ...placed.map(node => node.x + NODE_WIDTH + 200))
  const height = Math.max(600, ...placed.map(node => node.y + NODE_HEIGHT + 200))

  return (
    <div
      ref={hostRef}
      className="dsh-console-flow-canvas"
      onPointerDown={onPointerDownCanvas}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      style={{
        position: 'relative',
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        minHeight: 420,
        cursor: panning === undefined ? 'default' : 'grabbing',
        background: 'var(--dsw-alias-bg-layer-2, #fafbfc)',
        borderRadius: 'var(--dsw-radius-r16, 16px)',
        border: '0.5px solid var(--dsw-alias-line, #dfe1e6)',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(scale)})`,
          transformOrigin: '0 0',
          width,
          height,
        }}
      >
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <defs>
            <marker id="dsh-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dsw-alias-line-strong, #b8bcc7)" />
            </marker>
          </defs>
          {edges.map(edge => {
            const from = placedById.get(edge.from)
            const to = placedById.get(edge.to)
            if (from === undefined || to === undefined) return null
            const path = edgePath(from, to)
            return (
              <g key={edge.id}>
                <path
                  d={path}
                  fill="none"
                  stroke="var(--dsw-alias-line-strong, #b8bcc7)"
                  strokeWidth={1.5}
                  {...(edge.mode === 'fork' ? { strokeDasharray: '6 4' } : {})}
                  markerEnd="url(#dsh-flow-arrow)"
                />
                {edge.label === undefined ? null : (
                  <text
                    x={(from.x + NODE_WIDTH + to.x) / 2}
                    y={(from.y + to.y) / 2 + NODE_HEIGHT / 2 - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--dsw-alias-text-3, #8b8f99)"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {placed.map(node => {
          const tone = toneOf(node.group)
          const isSelected = selected === node.id
          const style: CSSProperties = {
            position: 'absolute',
            left: node.x,
            top: node.y,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            boxSizing: 'border-box',
            padding: '8px 10px',
            borderRadius: 'var(--dsw-radius-r12, 12px)',
            border: `1px solid ${isSelected ? 'var(--dsw-alias-line-brand, #6b8cff)' : tone.border}`,
            background: tone.bg,
            color: tone.fg,
            opacity: node.enabled ? 1 : 0.45,
            cursor: onMove === undefined ? 'pointer' : 'grab',
            boxShadow: isSelected ? '0 0 0 2px var(--dsw-alias-line-brand, #6b8cff)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 2,
          }
          return (
            <div
              key={node.id}
              style={style}
              onPointerDown={event => { onSelect?.(node.id); onPointerDownNode(event, node) }}
              onDoubleClick={() => { onOpen?.(node.id) }}
              title={`${node.type}${node.sideEffect ? ' · 有副作用' : ''}`}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {node.state === undefined ? null : (
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: stateColor(node.state) }} />
                )}
                <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.label}
                </span>
              </div>
              <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-text-3, #8b8f99)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {node.type}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 6 }}>
        <button type="button" className="dsh-console-flow-zoom" onClick={() => { setScale(prev => Math.max(MIN_SCALE, prev * 0.9)) }}>−</button>
        <span style={{ fontSize: 11, lineHeight: '24px', color: 'var(--dsw-alias-text-3, #8b8f99)', minWidth: 36, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button type="button" className="dsh-console-flow-zoom" onClick={() => { setScale(prev => Math.min(MAX_SCALE, prev * 1.1)) }}>+</button>
      </div>
    </div>
  )
}
