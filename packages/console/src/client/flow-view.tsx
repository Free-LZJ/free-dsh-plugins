/**
 * 编排视图：左边画布，右边属性面板。
 *
 * 它只管「看见图」和「改一个节点」——**结构编辑（增删节点、连线）还没做**，所以这一版
 * 的定位是：能看懂现在是什么样、能改每个节点填什么、能挪位置。比只读树多说了一半，
 * 但没到「从零画一张流程」。
 *
 * 保存是**按节点**的：拖完一个节点只发那一个节点的坐标，不会把整张图交上去覆盖别人的改动。
 *
 * @module @free-lzj/dsh-console/client/flow-view
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FlowCanvas, type CanvasEdge, type CanvasNode } from './flow-canvas.tsx'
import type { LayoutAlign, LayoutDirection, LayoutStrategy } from '@free-lzj/dsh-decision'
import type { TriageFieldSpec, TriageFlow, TriageFlowNode, TriageNodeType, TriageSource } from './rules.tsx'

/** 一段节点上的条件，压缩成一行给人看。 */
function conditionsOf(edge: { readonly when?: readonly Readonly<Record<string, unknown>>[] }): string | undefined {
  const when = edge.when
  if (when === undefined || when.length === 0) return undefined
  // 线上只放得下**一个词**：完整条件挤在那里会叠成一团，反而什么都读不出来。
  // 想看全的在属性面板里。
  for (const condition of when) {
    const kind = typeof condition['kind'] === 'string' ? condition['kind'] : '?'
    const values = condition['any'] ?? condition['all'] ?? condition['labels'] ?? condition['patterns']
    if (Array.isArray(values) && values.length > 0) {
      const first = String(values[0] ?? '')
      const short = first.length > 14 ? `${first.slice(0, 14)}…` : first
      return values.length > 1 ? `${short} +${String(values.length - 1)}` : short
    }
    return kind
  }
  return undefined
}

/** 连接器 tab 的外观：选中的那条加底色。 */
function tabStyle(active: boolean): CSSProperties {
  return {
    fontSize: 12,
    lineHeight: '20px',
    padding: '4px 10px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    fontWeight: active ? 600 : 400,
  }
}

/** 把图摊成画布要的两种数组。 */
function toCanvas(flow: TriageFlow, types: ReadonlyMap<string, TriageNodeType>): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = flow.nodes.map(node => {
    const type = types.get(node.type)
    return {
      id: node.id,
      type: node.type,
      // `workflow` 节点显示它引用的工作流名——否则一排都叫「工作流」，看不出路由到谁。
      label: node.label ?? (node.type === 'workflow' && typeof node.config?.['workflow'] === 'string'
        ? '→ ' + node.config['workflow']
        : (type?.label ?? node.type)),
      group: type?.group ?? 'action',
      sideEffect: type?.sideEffect ?? false,
      x: node.pos?.x ?? 0,
      y: node.pos?.y ?? 0,
      enabled: node.enabled !== false,
    }
  })
  const edges: CanvasEdge[] = []
  for (const node of flow.nodes) {
    for (const [index, edge] of (node.out ?? []).entries()) {
      const label = conditionsOf(edge)
      edges.push({
        id: `${node.id}->${edge.to}#${String(index)}`,
        from: node.id,
        to: edge.to,
        ...(label === undefined ? {} : { label }),
        ...(edge.mode === 'fork' ? { mode: 'fork' as const } : {}),
      })
    }
  }
  return { nodes, edges }
}

/** 一个字段的输入控件。 */
function Field(props: {
  readonly name: string
  readonly spec: TriageFieldSpec
  readonly value: unknown
  readonly onChange: (value: unknown) => void
}): ReactNode {
  const { name, spec, value, onChange } = props
  const label = spec.label ?? name
  const base = { width: '100%', boxSizing: 'border-box' as const, fontSize: 13, lineHeight: '20px', padding: '6px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-primary)' }

  if (spec.type === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={value === true} onChange={event => { onChange(event.target.checked) }} />
        {label}
      </label>
    )
  }
  if (spec.type === 'enum' && spec.options !== undefined) {
    return (
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {label}
        <select style={base} value={typeof value === 'string' ? value : ''} onChange={event => { onChange(event.target.value) }}>
          <option value="">（未设置）</option>
          {spec.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    )
  }
  if (spec.type === 'text' || spec.type === 'json') {
    const shown = spec.type === 'json' ? JSON.stringify(value ?? spec.default ?? null, null, 2) : String(value ?? '')
    return (
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {label}
        <textarea
          style={{ ...base, minHeight: spec.type === 'json' ? 96 : 64, fontFamily: spec.type === 'json' ? 'monospace' : 'inherit', resize: 'vertical' }}
          value={shown}
          placeholder={spec.placeholder ?? ''}
          onChange={event => {
            if (spec.type === 'json') {
              try {
                onChange(JSON.parse(event.target.value) as unknown)
              } catch {
                // 半句 JSON 不该把面板打崩：先不管，等它变成合法 JSON 再收。
              }
              return
            }
            onChange(event.target.value)
          }}
        />
        {spec.hint === undefined ? null : <span style={{ display: 'block', marginTop: 2 }}>{spec.hint}</span>}
      </label>
    )
  }
  return (
    <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
      {label}
      <input
        style={base}
        type={spec.type === 'number' ? 'number' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={spec.placeholder ?? ''}
        onChange={event => {
          if (spec.type === 'number') {
            const parsed = Number(event.target.value)
            onChange(event.target.value === '' ? undefined : parsed)
            return
          }
          onChange(event.target.value)
        }}
      />
      {spec.hint === undefined ? null : <span style={{ display: 'block', marginTop: 2 }}>{spec.hint}</span>}
    </label>
  )
}

/** 编排视图的属性。 */
export interface FlowViewProps {
  readonly t: (key: never) => string
  readonly triage: TriageSource
}

/**
 * 编排视图。
 * @param props - 数据源。
 * @returns 画布与属性面板。
 */
export function FlowView({ triage }: FlowViewProps): ReactNode {
  const [flows, setFlows] = useState<readonly TriageFlow[]>([])
  const [types, setTypes] = useState<readonly TriageNodeType[]>([])
  const [error, setError] = useState('')
  const [failure, setFailure] = useState('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  /** 最近一次执行在图上留下的状态：节点 id → 成了 / 失败 / 挂起。 */
  const [trail, setTrail] = useState<ReadonlyMap<string, 'ok' | 'failed' | 'suspended'>>(new Map())
  /** 全屏看板：把规则页其余部分让出来，只留画布与面板。 */
  const [full, setFull] = useState(false)
  /** 自动布局的走向与松紧。 */
  const [direction, setDirection] = useState<LayoutDirection>('TB')
  const [strategy, setStrategy] = useState<LayoutStrategy>('layered')
  const [align, setAlign] = useState<LayoutAlign>('center')
  /**
   * 只看某一条规则的分支。
   *
   * 一张「全部分支并列」的大图必然拥挤：8 条链横着铺开，每条只占几个像素。聚焦之后
   * 剩下的节点仍留在原位，于是**空间记忆还在**——切回来时不用重新认图。
   */
  /** 当前连接器 tab；undefined 表示「全部」。 */
  /** vents = 看事件流（路由），workflows = 看子工作流。 */
  const [tab, setTab] = useState<'events' | 'workflows'>('events')
  /** 当前选中的图 id（一规则一文件之后，一张图就是一条规则）。 */
  const [flowId, setFlowId] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [graph, catalogue, runs] = await Promise.all([
        triage.flow(), triage.nodeTypes(), triage.runs(),
      ])
      // 取最新那条有图足迹的记录：画布上标的是「上一次真跑过什么」，不是历史汇总。
      const latest = runs.find(run => (run.nodes ?? []).some(node => node.nodeId !== undefined))
      const nextTrail = new Map<string, 'ok' | 'failed' | 'suspended'>()
      for (const node of latest?.nodes ?? []) {
        if (node.nodeId === undefined) continue
        nextTrail.set(node.nodeId, node.ok ? 'ok' : (node.failure === 'fatal' || node.failure === 'config' ? 'failed' : 'failed'))
      }
      setTrail(nextTrail)
      // 专属连接器的图排前面，`*` 的兜底排最后——兜底是「谁都没管时才走」的那条，
      // 默认落在一张兜底图上没有意义。
      setFlows([...graph.flows].sort((left, right) => {
        // 事件流排最前：它是入口，子工作流是被它调用的。
        const byKind = (left.trigger === undefined ? 1 : 0) - (right.trigger === undefined ? 1 : 0)
        if (byKind !== 0) return byKind
        // 专属连接器在全局兜底前面。
        const byGlobal = (left.connector === '*' ? 1 : 0) - (right.connector === '*' ? 1 : 0)
        return byGlobal !== 0 ? byGlobal : left.name.localeCompare(right.name)
      }))
      setTypes(catalogue)
      setError(graph.error ?? '')
      setLoading(false)
      // 选中项在新数据里还在就留着，否则清掉——避免对着一个已经不在的节点改。
      setSelected(prev => (prev !== undefined && graph.flows.some(flow => flow.nodes.some(node => node.id === prev)) ? prev : undefined))
    } catch (thrown: unknown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown))
      setLoading(false)
    }
  }, [triage])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void load() }, [load])

  /**
   * 全屏时按 ESC 退出。
   *
   * 光靠那个按钮不够稳：全屏层铺满整页之后，按钮可能被浮层盖住、或者被拖拽的手势
   * 吃掉。键盘兜底不依赖任何布局。
   */
  useEffect(() => {
    if (!full) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [full])

  const typeMap = useMemo(() => {
    const map = new Map<string, TriageNodeType>()
    for (const type of types) map.set(type.type, type)
    return map
  }, [types])

  /** 事件流：接事件的图（有 `trigger`）。 */
  const eventFlows: readonly TriageFlow[] = useMemo(
    () => flows.filter(item => item.trigger !== undefined),
    [flows],
  )
  /** 子工作流：被 workflow 节点调用的执行体。 */
  const workflows: readonly TriageFlow[] = useMemo(
    () => flows.filter(item => item.trigger === undefined),
    [flows],
  )

  /** 当前 tab 下能选的图。 */
  const visibleFlows: readonly TriageFlow[] = useMemo(
    () => (tab === 'workflows' ? workflows : eventFlows),
    [tab, eventFlows, workflows],
  )
  /** 实际画哪张：优先当前选中的，否则取 tab 下第一张。 */
  const flow: TriageFlow | undefined = useMemo(() => {
    const picked = visibleFlows.find(item => item.id === flowId)
    return picked ?? visibleFlows[0]
  }, [visibleFlows, flowId])


  const canvas = useMemo(() => {
    const base = flow === undefined ? { nodes: [], edges: [] } : toCanvas(flow, typeMap)
    // 把执行足迹贴到方块上；没跑过的保持无状态。
    return {
      ...base,
      nodes: base.nodes.map(node => {
        const state = trail.get(node.id)
        return state === undefined ? node : { ...node, state }
      }),
    }
  }, [flow, typeMap, trail])

  /** 换图时重挂载画布，让它按新坐标重新 fit。 */
  // 全屏换了尺寸，画布要重挂载才会重新适配（否则还停在旧缩放下，下面空一大片）。
  const canvasKey = (flow?.id ?? 'none') + (full ? ':full' : '')

  const node: TriageFlowNode | undefined = flow?.nodes.find(item => item.id === selected)
  const nodeType = node === undefined ? undefined : typeMap.get(node.type)

  /** 选中时把当前配置抄进草稿；之后的编辑只动草稿。 */
  useEffect(() => {
    setDraft(node?.config === undefined ? {} : { ...node.config })
    setDirty(false)
  }, [node?.id, node?.config])

  /**
   * 拖动结束：只提交坐标，然后**把图重新读回来**。
   *
   * 少了这一步，拖动结束时 drag 被清空，节点会立刻弹回旧坐标——保存其实成功了，
   * 只是页面手上的还是上一份数据。
   */
  const onMove = useCallback((id: string, x: number, y: number) => {
    void triage.saveFlowNode({ nodeId: id, flowId: flow?.id, pos: { x, y } }).then(result => {
      if (!result.ok) {
        setFailure(result.message ?? '坐标没有存下来')
        return
      }
      setFailure('')
      void load()
    })
  }, [triage, load, flow])

  /**
   * 双击节点：`workflow` 节点钻进去看它引用的子工作流，其余节点只是选中。
   *
   * 事件流里「路由到谁」和「谁在干什么」是两层，双击是最自然的进入方式。
   */
  /**
   * 按当前选的方向与方式重排整张图。
   *
   * 会**覆盖**人手摆过的位置——「自动布局」保留手摆的等于点了没反应。
   */
  const onAutoLayout = useCallback(() => {
    if (flow === undefined) return
    setFailure('')
    void triage.autoLayout({ flowId: flow.id, direction, strategy, align }).then(result => {
      if (!result.ok) {
        setFailure(result.message ?? '没有排成')
        return
      }
      setSelected(undefined)
      void load()
    })
  }, [triage, flow, direction, strategy, align, load])

  const onDrill = useCallback((id: string) => {
    const node = flow?.nodes.find(item => item.id === id)
    const target = node?.type === 'workflow' && typeof node.config?.['workflow'] === 'string'
      ? node.config['workflow']
      : undefined
    if (target !== undefined && workflows.some(item => item.id === target)) {
      setTab('workflows')
      setFlowId(target)
      setSelected(undefined)
      return
    }
    setSelected(id)
  }, [flow, workflows])

  const onSave = useCallback(() => {
    if (node === undefined) return
    void triage.saveFlowNode({ nodeId: node.id, config: draft }).then(result => {
      if (!result.ok) {
        setFailure(result.message ?? '没有存下来')
        return
      }
      setFailure('')
      setDirty(false)
      void load()
    })
  }, [node, draft, triage, load])

  if (loading) return <p style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>正在读规则图…</p>

  if (flows.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '22px' }}>
        <p>还没有节点图。</p>
        <p style={{ marginTop: 6 }}>
          现在的规则文件是旧格式（规则列表）。把规则一次性转成节点图之后，这里会显示可编排的流程。
        </p>
        {error === '' ? null : <p style={{ marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: 1,
      // **全屏 = 铺满整个窗口。**
      //
      // 关键是 z-index：之前给 60，压不过 DSH 自己的标题栏和左侧栏，于是看上去
      // 「内容被压在下面、顶部重叠」。这里给到最上层，把自己完整盖出来；内容照旧
      // 从上到下排，不会被谁挡住。
      ...(full
        ? {
          position: 'fixed' as const,
          inset: 0,
          zIndex: 9999,
          background: 'var(--dsw-alias-bg-layer-1)',
          padding: 16,
        }
        : {}),
    }}>
      {failure === '' ? null : <p role="status" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{failure}</p>}

      {/* 两类东西分开看：**事件流**是路由（一个事件一张），**子工作流**是被调用的执行体。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {eventFlows.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => { setTab('events'); setFlowId(item.id); setSelected(undefined) }}
            style={tabStyle(tab === 'events' && flow?.id === item.id)}
            title={item.trigger === undefined ? '' : '事件 ' + item.trigger}
          >
            事件流 · {item.trigger ?? item.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setTab('workflows'); setFlowId(undefined); setSelected(undefined) }}
          style={tabStyle(tab === 'workflows')}
        >
          子工作流（{String(workflows.length)}）
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {visibleFlows.length > 1 ? (
          <select
            value={flow?.id ?? ''}
            onChange={event => { setFlowId(event.target.value); setSelected(undefined) }}
            style={{ fontSize: 13, padding: '4px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-primary)' }}
          >
            {visibleFlows.map(item => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        ) : <span style={{ fontSize: 13, fontWeight: 500 }}>{flow?.name}</span>}
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {String(flow?.nodes.length ?? 0)} 个节点 · connector {flow?.connector}
          {selected === undefined ? ' · 点一个节点看它的配置，拖动能调位置' : ''}
        </span>
        {/* 自动布局：方向决定流程往哪边走，策略决定松紧。点一下重排并写回文件。 */}
        <select
          value={direction}
          onChange={event => { setDirection(event.target.value as LayoutDirection) }}
          title="流程走向"
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 6px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-secondary)' }}
        >
          <option value="TB">↓ 自上而下</option>
          <option value="BT">↑ 自下而上</option>
          <option value="LR">→ 从左到右</option>
          <option value="RL">← 从右到左</option>
        </select>
        <select
          value={strategy}
          onChange={event => { setStrategy(event.target.value as LayoutStrategy) }}
          title="排列方式"
          style={{ fontSize: 12, padding: '4px 6px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-secondary)' }}
        >
          <option value="layered">分层</option>
          <option value="compact">紧凑</option>
          <option value="compact">紧凑</option>
        </select>
        <select
          value={align}
          onChange={event => { setAlign(event.target.value as LayoutAlign) }}
          title="对齐方式"
          style={{ fontSize: 12, padding: '4px 6px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)', color: 'var(--dsw-alias-label-secondary)' }}
        >
          <option value="center">居中</option>
          <option value="start">左对齐</option>
          <option value="end">右对齐</option>
        </select>
        <button
          type="button"
          onClick={onAutoLayout}
          title="按选的方向和方式重排所有节点"
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }}
        >
          自动布局
        </button>
        <button
          type="button"
          onClick={() => { void load() }}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }}
        >
          重新读取
        </button>
        <button
          type="button"
          onClick={() => { setFull(prev => !prev) }}
          title={full ? '退出全屏' : '全屏看这张图'}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }}
        >
          {full ? '退出全屏' : '全屏'}
        </button>
        <select
          value=""
          onChange={event => {
            const type = event.target.value
            if (type === '') return
            void triage.addFlowNode({ type, ...(selected === undefined ? {} : { after: selected }) }).then(result => {
              if (!result.ok) { setFailure(result.message ?? '没有加进去'); return }
              setFailure('')
              void load()
            })
            event.target.value = ''
          }}
          title={selected === undefined ? '加到流程末尾' : '加在选中节点之后'}
          style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)' }}
        >
          <option value="">+ 新增节点</option>
          {types.map(type => <option key={type.type} value={type.type}>{type.label}（{type.type}）</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', minHeight: full ? 0 : 460, flex: full ? 1 : undefined, height: full ? '100%' : undefined, minWidth: 0 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
          <FlowCanvas
            key={canvasKey}
            fullscreen={full}
            nodes={canvas.nodes}
            edges={canvas.edges}
            selected={selected}
            onSelect={setSelected}
            onMove={onMove}
            onOpen={onDrill}
          />
        </div>

        {node === undefined || nodeType === undefined ? null : (
        <aside style={{ width: 300, flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(
            <>
              <div>
                <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>{node.label ?? nodeType.label}</div>
                <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {node.type} · {nodeType.group}{nodeType.sideEffect ? ' · 有副作用' : ''}
                </div>
              </div>

              {node.out === undefined || node.out.length === 0 ? null : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                    去向（改这里就是连线）
                  </span>
                  {node.out.map((edge, index) => (
                    <div key={`${edge.to}-${String(index)}`} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <select
                        value={edge.to}
                        onChange={event => {
                          const to = event.target.value
                          if (to === edge.to) return
                          void triage.relinkFlowEdge({ from: node.id, index, to }).then(result => {
                            if (!result.ok) { setFailure(result.message ?? '没有改成功'); return }
                            setFailure('')
                            void load()
                          })
                        }}
                        style={{ flex: 1, fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-settings-card-fill)' }}
                      >
                        {flow?.nodes.filter(item => item.id !== node.id).map(item => (
                          <option key={item.id} value={item.id}>{item.label ?? item.type}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        title="删掉这条出边"
                        onClick={() => {
                          void triage.relinkFlowEdge({ from: node.id, index }).then(result => {
                            if (!result.ok) { setFailure(result.message ?? '没有删掉'); return }
                            setFailure('')
                            void load()
                          })
                        }}
                        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', cursor: 'pointer' }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
                {Object.entries(nodeType.config ?? {}).map(([name, spec]) => (
                  <Field
                    key={name}
                    name={name}
                    spec={spec}
                    value={draft[name]}
                    onChange={value => {
                      setDirty(true)
                      setDraft(prev => {
                        const next = { ...prev }
                        if (value === undefined) delete next[name]
                        else next[name] = value
                        return next
                      })
                    }}
                  />
                ))}
                {Object.keys(nodeType.config ?? {}).length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                    这种节点没有可填的字段。
                  </p>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!dirty}
                  style={{
                    fontSize: 13, padding: '6px 14px', borderRadius: 8, cursor: dirty ? 'pointer' : 'default',
                    border: '0.5px solid var(--dsw-alias-state-business-primary)',
                    background: dirty ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                    color: 'var(--dsw-alias-state-business-primary)',
                    opacity: dirty ? 1 : 0.5,
                  }}
                >
                  保存这个节点
                </button>
                <button
                  type="button"
                  onClick={() => { setDraft(node.config === undefined ? {} : { ...node.config }); setDirty(false) }}
                  disabled={!dirty}
                  style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5 }}
                >
                  撤销改动
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  void triage.removeFlowNode(node.id).then(result => {
                    if (!result.ok) { setFailure(result.message ?? '没有删掉'); return }
                    setFailure('')
                    setSelected(undefined)
                    void load()
                  })
                }}
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' }}
              >
                删除这个节点
              </button>
            </>
          )}
        </aside>
        )}
      </div>
    </div>
  )
}
