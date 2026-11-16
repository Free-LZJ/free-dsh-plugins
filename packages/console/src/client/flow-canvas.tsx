/**
 * 节点图画布。
 *
 * **自己画，不引图库**：CSS 是通过 `styles.ts` 手工注入的（浏览器半边拿不到打包器
 * 生成的样式表），图库带来的那份样式进不来；而我们的图是规整的分层 DAG，几百行
 * SVG 就够。
 *
 * 三条硬规则：
 *
 * 1. **只用 `--dsw-alias-*` 语义 token**，不写死颜色。深色主题下写死的浅色会变成
 *    一片白方块。
 * 2. **形状区分角色**：触发器是胶囊、分支是小圆角、动作是圆角块、有副作用的带一道
 *    竖条。光靠文字读图太慢。
 * 3. **坐标由 Host 算**（`/rules/flow` 已经带回 `pos`），这里只负责画、拖、选。
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
  /** 卡片上补充的说明行（参数摘要）；最多画两行。 */
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

/** 画布上的一条边。 */
export interface CanvasEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  /** 边上写的条件摘要；无条件为空。 */
  readonly label?: string
  readonly mode?: 'fork'
}

/** 画布尺寸常量。 */
const NODE_WIDTH = 280
const NODE_HEIGHT = 104
const MIN_SCALE = 0.3
/** 自动 fit 的下限：再小字就读不出来，宁可让人滚动。 */
const FIT_FLOOR = 0.55
const MAX_SCALE = 2

/**
 * 一类节点的外观。
 *
 * 颜色全部走语义 token：`settings-card-fill` 是卡片底色，`state-*-primary` 是状态色，
 * 两者在深色主题下都会自己变。形状按角色分：触发器圆润、分支干脆、动作方中带圆。
 */
function lookOf(group: string, sideEffect: boolean): {
  bg: string
  border: string
  fg: string
  radius: string | number
  accent?: string
} {
  const card = 'var(--dsw-alias-settings-card-fill)'
  const stroke = 'var(--dsw-alias-settings-card-stroke)'
  const label = 'var(--dsw-alias-label-primary)'
  const accent = sideEffect ? 'var(--dsw-alias-state-warn-primary)' : undefined

  // 底色掺入一点语义色：色相区分角色，明度跟着主题走（color-mix 两边都是 token）。
  if (group === 'trigger') {
    return {
      bg: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, var(--dsw-alias-settings-card-fill))',
      border: 'var(--dsw-alias-state-business-primary)',
      fg: label,
      radius: 999,
      ...(accent === undefined ? {} : { accent }),
    }
  }
  if (group === 'control') {
    return {
      bg: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, var(--dsw-alias-settings-card-fill))',
      border: 'var(--dsw-alias-state-warn-primary)',
      fg: label,
      radius: 6,
      ...(accent === undefined ? {} : { accent }),
    }
  }
  return { bg: card, border: stroke, fg: label, radius: 14, ...(accent === undefined ? {} : { accent }) }
}

/** 执行状态那一点的颜色。 */
function stateColor(state: CanvasNode['state']): string {
  if (state === 'ok') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'failed') return 'var(--dsw-alias-state-error-primary)'
  return 'var(--dsw-alias-state-warn-primary)'
}

/** 一条边的两个端点（节点底边中点 → 目标顶边中点）。 */
function edgeAnchors(from: CanvasNode, to: CanvasNode): { x1: number; y1: number; x2: number; y2: number; dy: number } {
  const x1 = from.x + NODE_WIDTH / 2
  const y1 = from.y + NODE_HEIGHT
  const x2 = to.x + NODE_WIDTH / 2
  const y2 = to.y
  return { x1, y1, x2, y2, dy: Math.max(28, Math.abs(y2 - y1) / 2) }
}

/** 自上而下：从下边缘中点出发，落到上边缘中点。 */
function edgePath(from: CanvasNode, to: CanvasNode): string {
  const { x1, y1, x2, y2, dy } = edgeAnchors(from, to)
  return `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(y1 + dy)}, ${String(x2)} ${String(y2 - dy)}, ${String(x2)} ${String(y2)}`
}

/**
 * 条件标签写在曲线的哪一点上。
 *
 * **不能写中点**：从同一个节点扇出的多条边，中点全部落在同一水平线上，十来个标签
 * 会糊成一团，什么都读不出来。取靠终点那一段 —— 那里各条边已经横向散开（一个节点
 * 宽一个），标签才互不遮挡。
 * @param from - 起点节点。
 * @param to - 终点节点。
 * @returns 三次贝塞尔在 t=0.72 处的坐标。
 */
function edgeLabelAt(from: CanvasNode, to: CanvasNode): { x: number; y: number } {
  const { x1, y1, x2, y2, dy } = edgeAnchors(from, to)
  const t = 0.72
  const u = 1 - t
  const px = x1 * u * u * u + 3 * x1 * u * u * t + 3 * x2 * u * t * t + x2 * t * t * t
  const py = y1 * u * u * u + 3 * (y1 + dy) * u * u * t + 3 * (y2 - dy) * u * t * t + y2 * t * t * t
  return { x: px, y: py }
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
  /** 撑满整个窗口；由外层控制，画布只管铺满自己那块。 */
  readonly fullscreen?: boolean
}

/**
 * 画布。
 * @param props - 节点、边与回调。
 * @returns 可缩放平移的画布。
 */
export function FlowCanvas({ nodes, edges, selected, onSelect, onMove, onOpen, fullscreen = false }: FlowCanvasProps) {
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  /** 拖动中的临时坐标；松手才交给 onMove。 */
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | undefined>()
  const [panning, setPanning] = useState<{ x: number; y: number; panX: number; panY: number } | undefined>()
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 已经自动对过焦没有。只做一次：之后人怎么缩放平移都算他的。 */
  const fittedRef = useRef(false)

  /**
   * 把所有节点缩放到视野里。
   *
   * 没有这一步，一张 36 个节点的图打开时只看得见最上面几个。只在第一次拿到节点时做，
   * 之后人的缩放与平移不再被覆盖。
   */
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return
    const host = hostRef.current
    if (host === null) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 50 || rect.height < 50) return

    const padding = 28
    const minX = Math.min(...nodes.map(node => node.x))
    const minY = Math.min(...nodes.map(node => node.y))
    const maxX = Math.max(...nodes.map(node => node.x + NODE_WIDTH))
    const maxY = Math.max(...nodes.map(node => node.y + NODE_HEIGHT))
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    // 下限 0.55：缩到 40% 以下字就读不出来了，那种「全览」没有意义——宁可让人滚动。
    const next = Math.min(
      1,
      Math.max(FIT_FLOOR, Math.min((rect.width - padding * 2) / spanX, (rect.height - padding * 2) / spanY)),
    )
    setScale(next)
    // 内容比视野大时不居中（会裁掉左上）；从小留白开始，让人滚。
    const offsetX = spanX * next > rect.width - padding * 2 ? padding : (rect.width - spanX * next) / 2
    const offsetY = spanY * next > rect.height - padding * 2 ? padding : (rect.height - spanY * next) / 2
    setPan({ x: offsetX - minX * next, y: offsetY - minY * next })
    fittedRef.current = true
  }, [nodes, fullscreen])

  /**
   * 拖动与平移统一在 `window` 上收事件。
   *
   * 不用 `setPointerCapture`：那要求被捕获的元素在整个拖动期间都活着，而这个画布每帧
   * 都在重渲染节点——捕获一丢，`pointermove` 就再没人接，表现出来正是「拖不动」。
   */
  useEffect(() => {
    if (drag === undefined && panning === undefined) return
    const host = hostRef.current
    if (host === null) return

    const move = (event: PointerEvent): void => {
      const rect = host.getBoundingClientRect()
      if (drag !== undefined) {
        const x = (event.clientX - rect.left - pan.x) / scale - drag.dx
        const y = (event.clientY - rect.top - pan.y) / scale - drag.dy
        setDrag({ ...drag, x, y })
        return
      }
      if (panning !== undefined) {
        setPan({ x: panning.panX + (event.clientX - panning.x), y: panning.panY + (event.clientY - panning.y) })
      }
    }
    const up = (): void => {
      if (drag !== undefined) {
        onMove?.(drag.id, Math.round(drag.x), Math.round(drag.y))
        setDrag(undefined)
      }
      setPanning(undefined)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag, panning, pan, scale, onMove])

  /** 在节点上按下：选中并准备拖。 */
  const onPointerDownNode = useCallback((event: React.PointerEvent, node: CanvasNode) => {
    event.stopPropagation()
    onSelect?.(node.id)
    if (onMove === undefined) return
    const rect = hostRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const x = (event.clientX - rect.left - pan.x) / scale
    const y = (event.clientY - rect.top - pan.y) / scale
    setDrag({ id: node.id, dx: x - node.x, dy: y - node.y, x: node.x, y: node.y })
  }, [onMove, onSelect, pan, scale])

  /**
   * 空白处按下：平移；同时清掉选中。
   *
   * **必须显式排除节点**：合成事件的 stopPropagation 在委托到 root 的这套机制下
   * 挡不住父元素的 handler。不排除的话，拖节点会同时拖动整块画布，两个位移互相抵消，
   * 表现出来正是「节点拖不动」。
   */
  const onPointerDownCanvas = useCallback((event: React.PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-flow-node]') != null) return
    onSelect?.(undefined)
    setPanning({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y })
  }, [onSelect, pan])

  /** 滚轮缩放；按住 ctrl 时以指针为中心。 */
  const onWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * (event.deltaY > 0 ? 0.92 : 1.08))))
  }, [])

  /** 拖动中的位置优先于存下来的位置。 */
  const placed = useMemo(() => nodes.map(node => (
    drag?.id === node.id ? { ...node, x: drag.x, y: drag.y } : node
  )), [nodes, drag])

  const placedById = useMemo(() => {
    const map = new Map<string, CanvasNode>()
    for (const node of placed) map.set(node.id, node)
    return map
  }, [placed])

  const width = Math.max(900, ...placed.map(node => node.x + NODE_WIDTH + 200))
  const height = Math.max(500, ...placed.map(node => node.y + NODE_HEIGHT + 200))

  return (
    <div
      ref={hostRef}
      className="dsh-console-flow-canvas"
      onPointerDown={onPointerDownCanvas}
      onWheel={onWheel}
      style={{
        position: 'relative',
        overflow: 'hidden',
        width: '100%',
        height: fullscreen ? '100%' : '100%',
        minHeight: fullscreen ? 0 : 380,
        cursor: drag !== undefined ? 'grabbing' : panning === undefined ? 'default' : 'grabbing',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: fullscreen ? 0 : 'var(--dsw-radius-lg)',
        border: fullscreen ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
        userSelect: 'none',
        touchAction: 'none',
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
            <marker id="dsh-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dsw-alias-border-l3)" />
            </marker>
          </defs>
          {edges.map(edge => {
            const from = placedById.get(edge.from)
            const to = placedById.get(edge.to)
            if (from === undefined || to === undefined) return null
            const at = edgeLabelAt(from, to)
            return (
              <g key={edge.id}>
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  stroke="var(--dsw-alias-border-l3)"
                  strokeWidth={1.4}
                  {...(edge.mode === 'fork' ? { strokeDasharray: '5 4' } : {})}
                  markerEnd="url(#dsh-flow-arrow)"
                />
                {edge.label === undefined ? null : (
                  <text
                    x={at.x}
                    y={at.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill="var(--dsw-alias-label-secondary)"
                    // 先描一圈底色再填字：线从底下穿过时也读得清。
                    stroke="var(--dsw-alias-bg-layer-1)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {placed.map(node => {
          const look = lookOf(node.group, node.sideEffect)
          const isSelected = selected === node.id
          const style: CSSProperties = {
            position: 'absolute',
            left: node.x,
            top: node.y,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            boxSizing: 'border-box',
            padding: '8px 12px',
            borderRadius: look.radius,
            border: isSelected
              ? '1.5px solid var(--dsw-alias-state-business-primary)'
              : `1px solid ${look.border}`,
            background: look.bg,
            color: look.fg,
            opacity: node.enabled ? 1 : 0.45,
            cursor: onMove === undefined ? 'pointer' : 'grab',
            boxShadow: isSelected ? '0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 2,
            overflow: 'hidden',
          }
          return (
            <div
              key={node.id}
              data-flow-node={node.id}
              style={style}
              onPointerDown={event => { onPointerDownNode(event, node) }}
              onDoubleClick={() => { onOpen?.(node.id) }}
              title={[node.type, ...(node.sideEffect ? ['有副作用'] : []), ...(node.detail ?? [])].join(' / ')}
            >
              {/* 有副作用的节点：左边一道竖条，不看文字也知道它会动外部世界。 */}
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
                {/* 类型钉在右上角：一眼知道这格干什么，又不跟主标题抢位置。 */}
                <span style={{ fontSize: 10, lineHeight: '14px', padding: '1px 5px', borderRadius: 5, flex: 'none', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {node.type}
                </span>
              </div>
              {/* 参数摘要：说清这格具体处理什么，而不是一串编号。 */}
              {(node.detail ?? []).slice(0, 2).map((line, index) => (
                <span
                  key={String(index)}
                  style={{ fontSize: 11, lineHeight: '15px', color: index === 0 ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {line}
                </span>
              ))}
            </div>
          )
        })}
      </div>

      <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={() => { setScale(prev => Math.max(MIN_SCALE, prev * 0.9)) }} style={zoomStyle}>−</button>
        <span style={{ fontSize: 11, lineHeight: '24px', color: 'var(--dsw-alias-label-tertiary)', minWidth: 36, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button type="button" onClick={() => { setScale(prev => Math.min(MAX_SCALE, prev * 1.1)) }} style={zoomStyle}>+</button>
      </div>
    </div>
  )
}

/** 缩放按钮：与画布其它控件同一套 token。 */
const zoomStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 8,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-settings-card-fill)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '24px',
  cursor: 'pointer',
}
