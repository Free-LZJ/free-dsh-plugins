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
import type { ReactNode } from 'react'
import { FlowCanvas, type CanvasEdge, type CanvasNode } from './flow-canvas.tsx'
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

/** 把图摊成画布要的两种数组。 */
function toCanvas(flow: TriageFlow, types: ReadonlyMap<string, TriageNodeType>): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = flow.nodes.map(node => {
    const type = types.get(node.type)
    return {
      id: node.id,
      type: node.type,
      label: node.label ?? type?.label ?? node.type,
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
  const base = { width: '100%', boxSizing: 'border-box' as const, fontSize: 13, lineHeight: '20px', padding: '6px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'var(--dsw-alias-bg-layer, #fff)', color: 'var(--dsw-alias-text-1, #22242a)' }

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
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
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
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
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
    <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
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
  const [step, setStep] = useState(0)
  const [dirty, setDirty] = useState(false)
  /** 最近一次执行在图上留下的状态：节点 id → 成了 / 失败 / 挂起。 */
  const [trail, setTrail] = useState<ReadonlyMap<string, 'ok' | 'failed' | 'suspended'>>(new Map())

  const load = useCallback(async (): Promise<void> => {
    try {
      const [graph, catalogue, runs] = await Promise.all([triage.flow(), triage.nodeTypes(), triage.runs()])
      // 取最新那条有图足迹的记录：画布上标的是「上一次真跑过什么」，不是历史汇总。
      const latest = runs.find(run => (run.nodes ?? []).some(node => node.nodeId !== undefined))
      const nextTrail = new Map<string, 'ok' | 'failed' | 'suspended'>()
      for (const node of latest?.nodes ?? []) {
        if (node.nodeId === undefined) continue
        nextTrail.set(node.nodeId, node.ok ? 'ok' : (node.failure === 'fatal' || node.failure === 'config' ? 'failed' : 'failed'))
      }
      setTrail(nextTrail)
      setFlows(graph.flows)
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

  const typeMap = useMemo(() => {
    const map = new Map<string, TriageNodeType>()
    for (const type of types) map.set(type.type, type)
    return map
  }, [types])

  const flow = flows[step] ?? flows[0]
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

  const node: TriageFlowNode | undefined = flow?.nodes.find(item => item.id === selected)
  const nodeType = node === undefined ? undefined : typeMap.get(node.type)

  /** 选中时把当前配置抄进草稿；之后的编辑只动草稿。 */
  useEffect(() => {
    setDraft(node?.config === undefined ? {} : { ...node.config })
    setDirty(false)
  }, [node?.id, node?.config])

  /** 拖动结束：只提交坐标。 */
  const onMove = useCallback((id: string, x: number, y: number) => {
    void triage.saveFlowNode({ nodeId: id, pos: { x, y } }).then(result => {
      if (!result.ok) {
        setFailure(result.message ?? '坐标没有存下来')
        return
      }
      setFailure('')
    })
  }, [triage])

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

  if (loading) return <p style={{ fontSize: 13, color: 'var(--dsw-alias-text-3, #8b8f99)' }}>正在读规则图…</p>

  if (flows.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-text-3, #8b8f99)', lineHeight: '22px' }}>
        <p>还没有节点图。</p>
        <p style={{ marginTop: 6 }}>
          现在的规则文件是旧格式（规则列表）。把规则一次性转成节点图之后，这里会显示可编排的流程。
        </p>
        {error === '' ? null : <p style={{ marginTop: 6, color: 'var(--dsw-alias-text-danger, #d93f3f)' }}>{error}</p>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: 1 }}>
      {failure === '' ? null : <p role="status" style={{ fontSize: 12, color: 'var(--dsw-alias-text-danger, #d93f3f)' }}>{failure}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {flows.length > 1 ? (
          <select
            value={String(step)}
            onChange={event => { setStep(Number(event.target.value)); setSelected(undefined) }}
            style={{ fontSize: 13, padding: '4px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)' }}
          >
            {flows.map((item, index) => <option key={item.id} value={String(index)}>{item.name}</option>)}
          </select>
        ) : <span style={{ fontSize: 13, fontWeight: 500 }}>{flow?.name}</span>}
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
          {String(flow?.nodes.length ?? 0)} 个节点 · connector {flow?.connector}
          {selected === undefined ? ' · 点一个节点看它的配置，拖动能调位置' : ''}
        </span>
        <button
          type="button"
          onClick={() => { void load() }}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'transparent', cursor: 'pointer' }}
        >
          重新读取
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
          style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'var(--dsw-alias-bg-layer, #fff)' }}
        >
          <option value="">+ 新增节点</option>
          {types.map(type => <option key={type.type} value={type.type}>{type.label}（{type.type}）</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', minHeight: 460 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
          <FlowCanvas
            key={flow?.id ?? 'none'}
            nodes={canvas.nodes}
            edges={canvas.edges}
            selected={selected}
            onSelect={setSelected}
            onMove={onMove}
          />
        </div>

        {node === undefined || nodeType === undefined ? null : (
        <aside style={{ width: 300, flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(
            <>
              <div>
                <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>{node.label ?? nodeType.label}</div>
                <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
                  {node.type} · {nodeType.group}{nodeType.sideEffect ? ' · 有副作用' : ''}
                </div>
              </div>

              {node.out === undefined || node.out.length === 0 ? null : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
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
                        style={{ flex: 1, fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'var(--dsw-alias-bg-layer, #fff)' }}
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
                        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'transparent', cursor: 'pointer' }}
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
                  <p style={{ fontSize: 12, color: 'var(--dsw-alias-text-3, #8b8f99)' }}>
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
                    border: '0.5px solid var(--dsw-alias-line-brand, #6b8cff)',
                    background: dirty ? 'var(--dsw-alias-fill-tint-brand, #eef4ff)' : 'transparent',
                    color: 'var(--dsw-alias-text-brand, #2a4bd8)',
                    opacity: dirty ? 1 : 0.5,
                  }}
                >
                  保存这个节点
                </button>
                <button
                  type="button"
                  onClick={() => { setDraft(node.config === undefined ? {} : { ...node.config }); setDirty(false) }}
                  disabled={!dirty}
                  style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'transparent', cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5 }}
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
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-line, #dfe1e6)', background: 'transparent', color: 'var(--dsw-alias-text-danger, #d93f3f)', cursor: 'pointer' }}
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
