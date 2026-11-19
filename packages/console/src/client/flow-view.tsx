/** * 编排视图：左边画布，右边属性面板。 * * 它只管「看见图」和「改一个节点」——**结构编辑（增删节点、连线）还没做**，所以这一版 * 的定位是：能看懂现在是什么样、能改每个节点填什么、能挪位置。比只读树多说了一半， * 但没到「从零画一张流程」。 * * 保存是**按节点**的：拖完一个节点只发那一个节点的坐标，不会把整张图交上去覆盖别人的改动。 * * @module @free-lzj/dsh-console/client/flow-view */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FlowCanvas, type CanvasEdge, type CanvasNode } from './flow-canvas.tsx'
import { ConditionEditor, conditionIssues } from './condition-editor.tsx'
import type { LayoutAlign, LayoutDirection, LayoutStrategy } from '@free-lzj/dsh-decision'
import { detectConflicts } from './flow-conflicts.ts'
import type { TriageFieldSpec, TriageFlow, TriageFlowNode, TriageNodeType, TriageRun, TriageSource } from './rules.tsx'
/** 一段节点上的条件，压缩成一行给人看。 */ /** 把一组条件读成一句人话；线上就写这一句。 */
function conditionsOf(edge: { readonly when?: readonly Readonly<Record<string, unknown>>[] }): string | undefined {
  const when = edge.when
  if (when === undefined || when.length === 0) return '兜底'
  return when.map(describeCondition).join(' 且 ')
}
/** 一条条件的可读形式。值**不截断**——截了就看不出这条线到底在判什么。 */
function describeCondition(condition: Readonly<Record<string, unknown>>): string {
  const kind = typeof condition['kind'] === 'string' ? condition['kind'] : '条件'
  const any = Array.isArray(condition['any']) ? condition['any'].map((item) => String(item)) : undefined
  const all = Array.isArray(condition['all']) ? condition['all'].map((item) => String(item)) : undefined
  const labels = Array.isArray(condition['labels']) ? condition['labels'].map((item) => String(item)) : undefined
  const values = any ?? all ?? labels
  const suffix = any === undefined ? '' : any.length > 1 ? ' (任一)' : ''
  if (kind === 'classifier') {
    return `判定 ${labels === undefined || labels.length === 0 ? '任意标签' : labels.join('/')}`
  }
  if (kind === 'regex') {
    const field = typeof condition['pattern'] === 'string' ? condition['pattern'] : ''
    const target = typeof condition['field'] === 'string' ? condition['field'] : '正文'
    return `正则 ${field} 命中${target}`
  }
  if (values !== undefined && values.length > 0) return `${kind} ${values.join(', ')}${suffix}`
  const scalar = condition['value'] ?? condition['equals'] ?? condition['any']
  return scalar === undefined ? kind : `${kind} ${String(scalar)}`
}
/** 一个节点的参数摘要：说清它具体处理什么。 */
function detailOf(node: TriageFlowNode, type: TriageNodeType | undefined): string[] {
  const config = node.config ?? {}
  const text = (key: string): string | undefined => {
    const value = config[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const list = (key: string): string[] | undefined => {
    const value = config[key]
    return Array.isArray(value) ? value.map((item) => String(item)) : undefined
  }
  if (node.type === 'trigger') return [`事件 ${text('event') ?? '（未设置）'}`]
  if (node.type === 'switch') {
    const out = node.out ?? []
    const withCondition = out.filter((edge) => (edge.when ?? []).length > 0).length
    return [`${String(out.length)} 条出边 · ${String(withCondition)} 条带条件`, '按顺序判定，第一条命中的生效']
  }
  if (node.type === 'workflow') {
    const pass = list('pass')
    return [
      `调用 ${text('workflow') ?? '（未选子工作流）'}`,
      pass === undefined ? '传入全部变量' : `传入 ${pass.join(', ')}`,
    ]
  }
  if (node.type === 'end') return ['流程结束']
  // 动作类节点：把配置里最有信息量的两个字段摆出来。

  const title = text('title')
  const tone = text('tone')
  if (title !== undefined) return [`标题 ${title}`, ...(tone === undefined ? [] : [`语气 ${tone}`])]
  const moved = text('target') ?? text('folder')
  if (moved !== undefined) return [`目标 ${moved}`]
  const model = text('model')
  if (model !== undefined)
    return [`模型 ${model}`, ...(text('prompt') === undefined ? [] : [`提示词 ${String(text('prompt')).slice(0, 80)}`])]
  /** 兜底：把配置里的前两个字段名和值列出来，总比只显示编号强。 */
  const entries = Object.entries(config).filter(
    ([, value]) => value !== undefined && value !== null && typeof value !== 'object',
  )
  if (entries.length === 0) return [type?.label === undefined ? node.type : `${type.label}（无参数）`]
  return entries.slice(0, 2).map(([key, value]) => `${key} ${String(value).slice(0, 60)}`)
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
/** 这个节点调用的子工作流（不是 `workflow` 类型、或引用的那张图没读到，就是 undefined）。 */
function referencedWorkflow(
  node: TriageFlowNode,
  workflowOf: ReadonlyMap<string, TriageFlow>,
): TriageFlow | undefined {
  if (node.type !== 'workflow') return undefined
  const id = node.config?.['workflow']
  return typeof id === 'string' ? workflowOf.get(id) : undefined
}
/**
 * 节点显示名：自己写的 `label` → 被调用工作流的中文 `name` → 类型名。
 *
 * `mail-new` 的 11 个 `workflow` 节点一个 `label` 都没写，只按 last resort 显示的话，
 * 画布上是 `→ ai-dev`、面板下拉里是 `workflow`——十一个分支看起来一模一样，
 * 而 `workflows/*.yml` 里明明每张都写了中文名。
 */
function nodeTitle(
  node: TriageFlowNode,
  type: TriageNodeType | undefined,
  workflowOf: ReadonlyMap<string, TriageFlow>,
): string {
  if (node.label !== undefined) return node.label
  const target = referencedWorkflow(node, workflowOf)
  if (target !== undefined) return target.name
  if (node.type === 'workflow') {
    const id = node.config?.['workflow']
    if (typeof id === 'string') return '→ ' + id
  }
  return type?.label ?? node.type
}
/** 节点第二行说明：节点自己的 `desc` → 被调用工作流的 `description`。 */
function nodeDesc(node: TriageFlowNode, workflowOf: ReadonlyMap<string, TriageFlow>): string | undefined {
  return node.desc ?? referencedWorkflow(node, workflowOf)?.description
}
/** 把图摊成画布要的两种数组。 */
function toCanvas(
  flow: TriageFlow,
  types: ReadonlyMap<string, TriageNodeType>,
  workflowOf: ReadonlyMap<string, TriageFlow>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  /** 每个节点的入边条件：一条出边的条件就是「这个节点被什么命中」。 */
  const inboundOf = new Map<string, string[]>()
  for (const source of flow.nodes) {
    for (const edge of source.out ?? []) {
      const text = conditionsOf(edge)
      if (text === undefined) continue
      const list = inboundOf.get(edge.to)
      if (list === undefined) inboundOf.set(edge.to, [text])
      else list.push(text)
    }
  }
  const nodes: CanvasNode[] = flow.nodes.map((node) => {
    const type = types.get(node.type)
    const inbound = inboundOf.get(node.id) ?? []
    /**
     * **条件画在节点上，不画在线上。**
     *
     * 同一个节点扇出的边，中点全落在一条水平线上，十来个标签必然糊成一团。
     * 而「这条边的条件」本来就等于「目标节点被什么命中」——跟着节点走既不重叠，
     * 也正好回答「这个分支凭什么进来」。
     */
    const condition =
      inbound.length === 0 ? undefined : inbound.length === 1 ? inbound[0] : `${String(inbound.length)} 条入边`
    const detail = detailOf(node, type)
    const desc = nodeDesc(node, workflowOf)
    /**
     * 有简介就用简介顶掉「调用 xxx」那行：卡片只有两行位置，`调用 ai-dev` 只是把
     * 节点 id 重复一遍，而「这条分支到底干什么」只有简介说得清。
     */
    const lines = desc === undefined ? detail : [desc, ...detail.slice(1)]
    return {
      id: node.id,
      type: node.type,
      /**
       * 显示名按这个顺序退：节点自己写的 `label` → 被调用工作流的中文名 → 类型名。
       * 以前只认 `label`，而 `mail-new` 的 11 个 `workflow` 节点都没写，画布上退化成
       * `→ ai-dev`、右侧下拉更是全变成 `workflow`，十一个分支看着一模一样。
       */
      label: nodeTitle(node, type, workflowOf),
      detail: condition === undefined ? lines : ['条件 ' + condition, ...lines],
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
      // 条件已经画在目标节点上了，线上只留一个序号，免得糊成一片。

      const label = undefined as string | undefined
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
/** * 一串「名字 + 必填」的编辑器，给开始节点的入参与结束节点的出参用。 * * 两种写法都收下：`['subject']`（手写 yml 时省事）和 `[{ name, required }]`。写回时统一 * 成后者——必填与否该让人看得见，不该靠「是字符串还是对象」来暗示。 * @param props - 当前值与改动回调。 * @returns 一行一个变量，加一个按钮。 */
function NameList(props: { readonly value: unknown; readonly onChange: (next: unknown) => void }): ReactNode {
  /** 空行要单独记：空名字写不回配置里，靠 `value` 是画不出「刚点出来的那一行」的。 */
  const [blank, setBlank] = useState(0)
  const stored = (Array.isArray(props.value) ? props.value : []).flatMap((item) => {
    if (typeof item === 'string' && item.trim() !== '') return [{ name: item.trim(), required: false }]
    if (typeof item !== 'object' || item === null) return []
    const record = item as { readonly name?: unknown; readonly required?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') return []
    return [{ name: record.name.trim(), required: record.required === true }]
  })
  const rows = [...stored, ...Array.from({ length: blank }, () => ({ name: '', required: false }))]
  /** 写回：空名字的行丢掉，免得存一串垃圾；全删光就写 undefined（配置里不留空壳）。 */
  const commit = (next: readonly { name: string; required: boolean }[]): void => {
    const kept = next.filter((row) => row.name.trim() !== '')
    props.onChange(kept.length === 0 ? undefined : kept.map((row) => ({ name: row.name, required: row.required })))
    setBlank(next.filter((row) => row.name.trim() === '').length)
  }
  const rowStyle = {
    flex: 1,
    fontSize: 12,
    lineHeight: '18px',
    padding: '3px 6px',
    borderRadius: 'var(--dsw-radius-sm)',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-settings-card-fill)',
    color: 'var(--dsw-alias-label-primary)',
  } as const
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((row, index) => (
        // 键用下标：按名字做键的话，敲第一个字母就换了一次键，输入框会被重建、焦点丢掉。

        <div key={String(index)} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={row.name}
            placeholder='变量名，比如 subject'
            onChange={(event) => {
              const next = [...rows]
              next[index] = { ...row, name: event.target.value }
              commit(next)
            }}
            style={rowStyle}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            <input
              type='checkbox'
              checked={row.required}
              onChange={(event) => {
                const next = [...rows]
                next[index] = { ...row, required: event.target.checked }
                commit(next)
              }}
            />
            必填
          </label>
          <button
            type='button'
            aria-label={`删掉 ${row.name}`}
            onClick={() => {
              commit(rows.filter((_item, at) => at !== index))
            }}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 'var(--dsw-radius-sm)',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary)',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={() => {
          setBlank((count) => count + 1)
        }}
        style={{
          alignSelf: 'flex-start',
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 'var(--dsw-radius-sm)',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
        }}
      >
        + 加一个
      </button>
    </div>
  )
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
  const base = {
    width: '100%',
    boxSizing: 'border-box' as const,
    fontSize: 13,
    lineHeight: '20px',
    padding: '6px 8px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-settings-card-fill)',
    color: 'var(--dsw-alias-label-primary)',
  }
  if (spec.type === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type='checkbox'
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked)
          }}
        />
        {label}
      </label>
    )
  }
  if (spec.type === 'enum' && spec.options !== undefined) {
    return (
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {label}
        <select
          style={base}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        >
          <option value=''>（未设置）</option>
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }
  if (spec.type === 'names') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>{label}</span>
        <NameList value={value} onChange={onChange} />
        {spec.hint === undefined ? null : (
          <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {spec.hint}
          </span>
        )}
      </div>
    )
  }
  if (spec.type === 'text' || spec.type === 'json') {
    // 没写过就是空：往空的 JSON 框里塞一句 `null`，读起来像「这里有个值，值是 null」。

    const shown =
      spec.type === 'json'
        ? value === undefined && spec.default === undefined
          ? ''
          : JSON.stringify(value ?? spec.default ?? null, null, 2)
        : String(value ?? '')
    return (
      <label style={{ display: 'block', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {label}
        <textarea
          style={{
            ...base,
            minHeight: spec.type === 'json' ? 96 : 64,
            fontFamily: spec.type === 'json' ? 'monospace' : 'inherit',
            resize: 'vertical',
          }}
          value={shown}
          placeholder={spec.placeholder ?? ''}
          onChange={(event) => {
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
        onChange={(event) => {
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
/** * 编排视图。 * @param props - 数据源。 * @returns 画布与属性面板。 */
export function FlowView({ triage }: FlowViewProps): ReactNode {
  const [flows, setFlows] = useState<readonly TriageFlow[]>([])
  const [types, setTypes] = useState<readonly TriageNodeType[]>([])
  const [error, setError] = useState('')
  const [failure, setFailure] = useState('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  /** 选中的连线：`{ from, index }`，用来改它的条件。 */
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; index: number } | undefined>(undefined)
  /**
   * 正在等二次确认的「删除这个节点」。
   *
   * 删节点是**不经过保存按钮**的写盘操作：点一下就没了，连线一起没，配置也回不来。
   * 别的改动都有「撤销改动」，它没有——所以它必须先问一句。
   */
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  /** 正在等二次确认的「删除这条连线」：值是 `<from>#<index>`。删线同样是直接写盘。 */
  const [confirmingEdge, setConfirmingEdge] = useState<string | undefined>(undefined)
  /** 冲突提示默认只列 4 条：再多就先收着，点开看全部。 */
  const [showAllConflicts, setShowAllConflicts] = useState(false)
  /** 正在填名字的新子工作流（undefined = 没在新建）。 */
  const [creatingFlow, setCreatingFlow] = useState<string | undefined>(undefined)
  /** 自动布局刚算完的坐标：id → 位置。见下面 canvasNodes 的说明。 */
  /** 刚成功的操作留一句话（比如「已重排 14 个节点」）。 */
  const [notice, setNotice] = useState('')
  const [layoutPositions, setLayoutPositions] = useState<
    ReadonlyMap<string, { readonly x: number; readonly y: number }> | undefined
  >(undefined)
  /** 等着被选中的新分支边：图重载完才设，因为那时才有 `edgeSpec`。 */
  const [pendingRuleEdge, setPendingRuleEdge] = useState<{ from: string; index: number } | undefined>(undefined)
  /**
   * 正在新建的分支：名字与条件一起攒着，点「建」才落盘。
   *
   * 条件必须和边一起写：先建边后填条件的话，中间那一刻它是一条**无条件**的边，
   * 会把后面所有分支挡掉。
   */
  const [creating, setCreating] = useState<{ name: string; conditions: Record<string, unknown>[] } | undefined>(
    undefined,
  )
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)
  /** 最近一次执行在图上留下的状态：节点 id → 成了 / 失败 / 挂起。 */
  /** 最近几次执行：页脚那条足迹条从这里取。 */
  const [runs, setRuns] = useState<readonly TriageRun[]>([])
  /** 正在看哪一次执行的足迹；undefined = 跟最新那次。 */
  const [trailRunId, setTrailRunId] = useState<string | undefined>(undefined)
  /**
   * 试跑的结论：会走哪条边、其余边为什么没走。
   *
   * 「试跑」这一动作本来就该回答这两个问题，以前它只在列表里回一行字，编排的人
   * 还得自己把「分支 → promo」翻译成画布上的某一根线。
   */
  const [dry, setDry] = useState<
    | {
        readonly runId: string
        readonly edgeId?: string
        readonly verdict: string
        readonly pending: boolean
      }
    | undefined
  >(undefined)
  /** 全屏看板：把事件流页其余部分让出来，只留画布与面板。 */
  const [full, setFull] = useState(false)
  /**
   * 「画布该重新框一次」的计数器。
   *
   * 换图、增删节点之后由 {@link fitToken} 反映出来，自动布局之后再 +1——坐标变了
   * 但节点集合没变，只有计数器能表达这件事。
   */
  const [fitTick, setFitTick] = useState(0)
  /** 自动布局的走向与松紧。 */
  const [direction, setDirection] = useState<LayoutDirection>('TB')
  const [strategy, setStrategy] = useState<LayoutStrategy>('layered')
  const [align, setAlign] = useState<LayoutAlign>('center')
  /**
   * 只看某一条分支。
   *
   * 一张「全部分支并列」的大图必然拥挤：8 条链横着铺开，每条只占几个像素。聚焦之后
   * 剩下的节点仍留在原位，于是**空间记忆还在**——切回来时不用重新认图。
   */
  /** 当前连接器 tab；undefined 表示「全部」。 */
  /** events = 看事件流（路由），workflows = 看子工作流。 */
  const [tab, setTab] = useState<'events' | 'workflows'>('events')
  /** 当前选中的图 id（一图一文件之后，一张图就是一条事件流）。 */
  const [flowId, setFlowId] = useState<string | undefined>(undefined)
  /**
   * 画布该占多高：**可用空间**，不是一个常数。
   *
   * 这块面板比窗口矮（DSH 的标题栏压在它上面），窗口本身又不可滚动。以前画布写死
   * 640，算下来比剩余空间还高，底部那条（缩放控件、小地图、从左到右时最后一列）
   * 就被窗口切掉了——看上去像画布坏了，其实是它比该在的地方高出去一截。
   */
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [canvasHeight, setCanvasHeight] = useState(640)
  const load = useCallback(async (): Promise<void> => {
    try {
      const [graph, catalogue, records] = await Promise.all([triage.flow(), triage.nodeTypes(), triage.runs()])
      // 足迹留原始记录：标哪一次由 `trail` 那段派生决定，别再在这里算死。

      setRuns(records)
      // 专属连接器的图排前面，`*` 的兜底排最后——兜底是「谁都没管时才走」的那条，

      // 默认落在一张兜底图上没有意义。

      setFlows(
        [...graph.flows].sort((left, right) => {
          // 事件流排最前：它是入口，子工作流是被它调用的。

          const byKind = (left.trigger === undefined ? 1 : 0) - (right.trigger === undefined ? 1 : 0)
          if (byKind !== 0) return byKind
          // 专属连接器在全局兜底前面。

          const byGlobal = (left.connector === '*' ? 1 : 0) - (right.connector === '*' ? 1 : 0)
          return byGlobal !== 0 ? byGlobal : left.name.localeCompare(right.name)
        }),
      )
      setTypes(catalogue)
      setError(graph.error ?? '')
      setLoading(false)
      // 选中项在新数据里还在就留着，否则清掉——避免对着一个已经不在的节点改。

      setSelected((prev) =>
        prev !== undefined && graph.flows.some((flow) => flow.nodes.some((node) => node.id === prev))
          ? prev
          : undefined,
      )
    } catch (thrown: unknown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown))
      setLoading(false)
    }
  }, [triage])
  useEffect(() => {
    void load()
  }, [load])
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
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [full])
  /**
   * 键盘：删掉选中的节点，或者退出选中。
   *
   * 编排一个十来步的流程时，鼠标要去右下角找「删除这个节点」，再来回一趟确认——
   * 键盘是这类画布的标准做法。删除仍然走那句二次确认，快捷键不绕过它。
   *
   * **在输入框里一律不管**：改条件、写标题的时候按退格，删的是字，不是节点。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target !== null && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
        target.isContentEditable
      )
      if (typing) return
      if (event.key === 'Escape') {
        setSelected(undefined)
        setSelectedEdge(undefined)
        setConfirmingDelete(undefined)
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (selected === undefined) return
      // 有输入焦点在别处（比如刚点开一个下拉）时不抢：只在「看着画布」时才当快捷键。
      event.preventDefault()
      setConfirmingDelete(selected)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [selected])
  /**
   * 量一次「画布还能占多高」。
   *
   * 只在布局阶段量：这里读的是元素实际落在哪，写回的是它的高度——放到 `useEffect`
   * 里会先闪一帧旧高度。
   *
   * 依赖里必须带上 `loading`：图还没读完时这一页返回的是「正在读事件流…」，那会儿
   * 根本没有画布可量；等它换成真画布时得再量一次。
   */
  useLayoutEffect(() => {
    if (full) return
    const measure = (): void => {
      const element = shellRef.current
      if (element === null) return
      const top = element.getBoundingClientRect().top
      // 底部留 16px：贴着窗口最下沿既容易被浮层盖住，看着也局促。

      setCanvasHeight(Math.max(320, Math.round(window.innerHeight - top - 16)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
    }
  }, [full, loading])
  const typeMap = useMemo(() => {
    const map = new Map<string, TriageNodeType>()
    for (const type of types) map.set(type.type, type)
    return map
  }, [types])
  /** 事件流：接事件的图（有 `trigger`）。 */
  const eventFlows: readonly TriageFlow[] = useMemo(() => flows.filter((item) => item.trigger !== undefined), [flows])
  /** 子工作流：被 workflow 节点调用的执行体。 */
  const workflows: readonly TriageFlow[] = useMemo(() => flows.filter((item) => item.trigger === undefined), [flows])
  /** 当前 tab 下能选的图。 */
  const visibleFlows: readonly TriageFlow[] = useMemo(
    () => (tab === 'workflows' ? workflows : eventFlows),
    [tab, eventFlows, workflows],
  )
  /** 实际画哪张：优先当前选中的，否则取 tab 下第一张。 */
  const flow: TriageFlow | undefined = useMemo(() => {
    const picked = visibleFlows.find((item) => item.id === flowId)
    return picked ?? visibleFlows[0]
  }, [visibleFlows, flowId])
  /**
   * 这条执行属于哪张图。
   *
   * 一次事件会跨图：`mail-new` 判完调 `promo`。旧记录没有 `flows`（那时没存），退回按
   * 节点 id 认——只认**这张图独有的** id，`trigger` / `route` / `end` 到处都有，不能算数。
   */
  const belongsTo = useCallback((run: TriageRun, target: TriageFlow | undefined): boolean => {
    if (target === undefined) return false
    const flows = run.flows ?? []
    if (flows.some((id) => id === target.id || id.startsWith(target.id + '/'))) return true
    if (flows.length > 0) return false
    const shared = new Set(['trigger', 'route', 'end', 'start', 'rest', 'classify'])
    const own = new Set(target.nodes.map((node) => node.id).filter((id) => !shared.has(id)))
    return (run.nodes ?? []).some((node) => node.nodeId !== undefined && own.has(node.nodeId))
  }, [])
  /** 这张图跑过的执行，最新的在前。按时间排，不赌接口给的顺序。 */
  const flowRuns = useMemo(
    () => runs.filter((run) => belongsTo(run, flow)).sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
    [runs, flow, belongsTo],
  )
  /**
   * 画布上要标的那一次。
   *
   * 旧代码取的是「最新一条有足迹的记录」，不分图——于是看完 `promo` 的一次执行，回到
   * `mail-new` 画布上标记会整片消失（那张图的方块 id 在这条记录里一个都没有）。
   */
  const activeRun = useMemo(() => {
    if (trailRunId !== undefined) {
      const picked = flowRuns.find((run) => run.id === trailRunId)
      if (picked !== undefined) return picked
    }
    return flowRuns[0]
  }, [flowRuns, trailRunId])
  /** 方块 id → 那次执行里它的结果。只标当前这张图的方块。 */
  const trail = useMemo(() => {
    const marks = new Map<string, 'ok' | 'failed' | 'suspended'>()
    if (activeRun === undefined || flow === undefined) return marks
    const own = new Set(flow.nodes.map((node) => node.id))
    for (const node of activeRun.nodes ?? []) {
      if (node.nodeId === undefined) continue
      if (node.flowId !== undefined && node.flowId !== flow.id) continue
      if (!own.has(node.nodeId)) continue
      marks.set(node.nodeId, node.ok ? 'ok' : 'failed')
    }
    return marks
  }, [activeRun, flow])
  /** 子工作流按 id 索引：`workflow` 节点靠它把「调了谁」翻成中文名和简介。 */
  const workflowById = useMemo(() => {
    const map = new Map<string, TriageFlow>()
    for (const item of workflows) map.set(item.id, item)
    return map
  }, [workflows])
  /**
   * 面板里的下拉、上游列表、选中标题统一用这个：跟画布上看到的名字是同一个。
   *
   * 顺手把 id 带上（`中文名（call-promo）`）——同类型节点没有中文名时，
   * 只显示 `workflow` 就又是十一个一模一样的选项。
   */
  const labelOf = useCallback(
    (item: TriageFlowNode): string => {
      const title = nodeTitle(item, typeMap.get(item.type), workflowById)
      return title === item.id ? title : `${title}（${item.id}）`
    },
    [typeMap, workflowById],
  )
  const canvas = useMemo(() => {
    const base = flow === undefined ? { nodes: [], edges: [] } : toCanvas(flow, typeMap, workflowById)
    // 把执行足迹贴到方块上；没跑过的保持无状态。

    return {
      ...base,
      nodes: base.nodes.map((node) => {
        const state = trail.get(node.id)
        return state === undefined ? node : { ...node, state }
      }),
    }
  }, [flow, typeMap, workflowById, trail])
  /**
   * 刚算完的自动布局坐标。
   *
   * 引擎确实把新坐标写进了文件（实测接口 `200 {"ok":true}`、文件哈希和 `pos` 都变了），
   * 但画布上那 14 个节点一个都不动——看着就像按钮没反应。与其去赌「重读一遍就位」，
   * 不如把接口算出来的坐标直接画上来。
   */
  const canvasNodes = useMemo(() => {
    if (layoutPositions === undefined) return canvas.nodes
    return canvas.nodes.map((item) => {
      const at = layoutPositions.get(item.id)
      return at === undefined ? item : { ...item, x: at.x, y: at.y }
    })
  }, [canvas.nodes, layoutPositions])
  // 换图就把上一张图的布局结果丢掉：节点 id 各图不同，留着只会串味。
  useEffect(() => {
    setLayoutPositions(undefined)
    setNotice('')
    // 换图时顺手把连线相关的 UI 状态一起放掉：节点 id 各图不同，留着只会串味。
    setSelectedEdge(undefined)
    setConfirmingEdge(undefined)
  }, [flow?.id])
  /** 同一节点上互相抢的分支。静态算，不跑模型。 */
  const conflicts = useMemo(() => (flow === undefined ? [] : detectConflicts(flow)), [flow])
  /** 还没补开始/结束的子工作流：一张张点进去补太啰嗦，这里给一次补齐的入口。 */
  const withoutEndpoints = useMemo(
    () => workflows.filter((item) => (
      !item.nodes.some((node) => node.type === 'start') || !item.nodes.some((node) => node.type === 'end')
    )),
    [workflows],
  )
  /** 连线总数：人问「这张图有多大」时看的就是节点数和边数。 */
  const edgeCount = useMemo(
    () => (flow === undefined ? 0 : flow.nodes.reduce((total, node) => total + (node.out?.length ?? 0), 0)),
    [flow],
  )
  /**
   * 交给画布的「重新框视口」令牌。
   *
   * 三件事会让视口必须重框：换了图（`flow.id`）、节点集合变了（增删）、刚做完自动
   * 布局（`fitTick`）。拖动节点不算——框一次会把用户刚摆的位置甩到别处。
   */
  const fitToken = `${flow?.id ?? ''}#${canvas.nodes.map((node) => node.id).join(',')}#${String(fitTick)}#${String(canvasHeight)}`
  /**
   * 重建画布的钥匙：**只认图和节点集合**，不认画布高度。
   *
   * 原来直接把 `fitToken` 当 `key`，而它含 `canvasHeight`；于是量一次高度就重建一次
   * 画布，重建又改尺寸、又触发新一轮测量——`FlowCanvasInner` 里那条「等三帧再 fit」
   * 的 rAF 链每次都被下一次重建的 cleanup 掐掉，一次也没跑到头。画布因此永远停在
   * `translate(0,0) scale(1)`：图比画布宽，右边一大半在可视区外面。
   */
  const canvasKey = `${flow?.id ?? ''}#${canvas.nodes.map((node) => node.id).join(',')}#${String(fitTick)}`
  /** 新分支还差什么：名字、至少一条条件、每条条件的必填字段。「建」按这个禁用。 */
  const creatingIssues: readonly string[] =
    creating === undefined
      ? []
      : [
          ...(creating.name.trim() === '' ? ['分支得有个名字'] : []),
          ...(creating.conditions.length === 0 ? ['至少给一条条件；没有条件的边是兜底，会把后面的分支全挡掉'] : []),
          ...creating.conditions.flatMap((condition) => conditionIssues(condition)),
        ]
  const node: TriageFlowNode | undefined = flow?.nodes.find((item) => item.id === selected)
  const nodeType = node === undefined ? undefined : typeMap.get(node.type)
  /**
   * 选中的 workflow 节点：它调用的子工作流需要哪些入参，这里传了哪些。
   *
   * `pass` 没写表示「传入全部变量」，那就不缺；写了就按名单对账。
   */
  const calling = useMemo(() => {
    if (node === undefined || node.type !== 'workflow') return undefined
    const targetId = typeof node.config?.['workflow'] === 'string' ? node.config['workflow'] : undefined
    if (targetId === undefined) return undefined
    const target = flows.find((item) => item.id === targetId)
    if (target === undefined) return undefined
    const start = target.nodes.find((item) => item.type === 'start')
    const declared = start?.config?.['params']
    const needs = (Array.isArray(declared) ? declared : []).flatMap((entry) => {
      if (typeof entry === 'string') return [{ name: entry, required: false, missing: false }]
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as { readonly name?: unknown; readonly required?: unknown }
      if (typeof record.name !== 'string' || record.name === '') return []
      return [{ name: record.name, required: record.required === true, missing: false }]
    })
    const pass = node.config?.['pass']
    const passed = Array.isArray(pass) ? pass.filter((item): item is string => typeof item === 'string') : undefined
    return {
      name: target.name,
      needs: needs.map((need) => ({
        ...need,
        // 只传名单里没列它 = 运行时缺；「传入全部变量」不算缺。
        missing: need.required && passed !== undefined && !passed.includes(need.name),
      })),
    }
  }, [node, flows])
  /**
   * 谁连到选中的节点。
   *
   * 面板一直只有「去向」——排查「这条为什么没跑」的时候，缺的偏偏是另一半：谁应该
   * 把事件递进来、递进来要满足什么条件。空数组本身也是信号：没人连到它，就是个走不到
   * 的孤岛。
   */
  const upstreams = useMemo(() => {
    if (flow === undefined || node === undefined) return []
    const rows: { from: TriageFlowNode; index: number; text: string }[] = []
    for (const source of flow.nodes) {
      ;(source.out ?? []).forEach((edge, index) => {
        if (edge.to !== node.id) return
        rows.push({ from: source, index, text: conditionsOf(edge) ?? '兜底' })
      })
    }
    return rows
  }, [flow, node])
  /** 试跑的结论落在哪条边上（`route->call-promo#1` 这种 id 里切出来）。 */
  /** 试跑的结论落在哪条边上：试跑回的 id 本身就是边的 id（`from->to#index`）。 */
  /**
   * 试跑结论只在「它问的那次执行」被选中时才算数。
   *
   * 足迹条可以切到别的执行：切过去还留着上一条的结论，人会拿它当这一条的答案看。
   */
  const dryNow = dry !== undefined && dry.runId === activeRun?.id ? dry : undefined
  const dryEdgeId = dryNow?.edgeId
  /** 拿一次真实执行去试跑：读那封邮件，按图算会走哪条边。 */
  const tryRunAgain = useCallback(
    (run: TriageRun) => {
      const accountId = run.event.accountId
      const uid = run.event.uid
      if (accountId === undefined || uid === undefined) return
      setDry({ runId: run.id, verdict: '', pending: true })
      void triage.testRun({ accountId, folder: run.event.folder, uid }).then((answer) => {
        if (!answer.ok) {
          setDry({ runId: run.id, verdict: `试跑没跑起来：${answer.message}`, pending: false })
          return
        }
        // 图模式下试跑喂的是「分支边」，所以命中的 id 本身就是一条边的 id。

        const edgeId = /^.*->.*#\d+$/.test(answer.result.ruleId) ? answer.result.ruleId : undefined
        setDry({
          runId: run.id,
          ...(edgeId === undefined ? {} : { edgeId }),
          verdict:
            edgeId === undefined
              ? `试跑：${answer.result.ruleName || '没有分支命中'}`
              : `试跑：会走 ${answer.result.ruleName}`,
          pending: false,
        })
      })
    },
    [triage],
  )
  const nodeStep =
    activeRun === undefined || node === undefined
      ? undefined
      : (activeRun.nodes ?? []).find((step) => step.nodeId === node.id)
  /** 选中连线时它的两端与定义，属性面板据此切成「改条件」。 */
  const edgeFrom = selectedEdge === undefined ? undefined : flow?.nodes.find((item) => item.id === selectedEdge.from)
  const edgeSpec = edgeFrom?.out?.[selectedEdge?.index ?? -1]
  const edgeKey = selectedEdge === undefined ? '' : `${selectedEdge.from}#${String(selectedEdge.index)}`
  /** 条件的编辑草稿；选中另一条边时整体换掉。 */
  const [edgeConditions, setEdgeConditions] = useState<Record<string, unknown>[]>([])
  useEffect(() => {
    setEdgeConditions((edgeSpec?.when ?? []).map((condition) => ({ ...condition })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey, flow])
  /** 图上出现过的条件类型，给下拉用。 */
  const conditionKinds = useMemo(() => {
    const seen = new Set<string>()
    for (const item of flow?.nodes ?? []) {
      for (const edge of item.out ?? []) {
        for (const condition of edge.when ?? []) {
          if (typeof condition['kind'] === 'string') seen.add(condition['kind'])
        }
      }
    }
    if (seen.size === 0)
      ['from', 'classifier'].forEach((kind) => {
        seen.add(kind)
      })
    return [...seen].sort()
  }, [flow])
  /** 保存这条边的条件。 */
  const saveEdge = useCallback(() => {
    if (selectedEdge === undefined || flow === undefined) return
    setFailure('')
    setNotice('')
    void triage
      .saveFlowEdge({
        from: selectedEdge.from,
        index: selectedEdge.index,
        flowId: flow.id,
        when: edgeConditions,
      })
      .then((result) => {
        if (!result.ok) {
          setFailure(result.message ?? '没有存下来')
          return
        }
        // 保存成功要出声：冲突提示会跟着变，但那是在图的另一处——人未必盯着那里。
        setNotice('条件已保存')
        void load()
      })
  }, [triage, selectedEdge, flow, edgeConditions, load])
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
  const onMove = useCallback(
    (id: string, x: number, y: number) => {
      void triage.saveFlowNode({ nodeId: id, flowId: flow?.id, pos: { x, y } }).then((result) => {
        if (!result.ok) {
          setFailure(result.message ?? '坐标没有存下来')
          return
        }
        setFailure('')
        void load()
      })
    },
    [triage, load, flow],
  )
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
  const onAutoLayout = useCallback((next?: {
    readonly direction?: LayoutDirection
    readonly strategy?: LayoutStrategy
    readonly align?: LayoutAlign
  }) => {
    if (flow === undefined) return
    setFailure('')
    setNotice('')
    // 下拉刚改完那一刻，state 还是旧值：换方向/换方式要立刻重排，就必须把新值传进来，
    // 否则点的永远是上一次的参数——排出来的坐标和原来一样，看着就是「按钮没反应」。
    void triage
      .autoLayout({
        flowId: flow.id,
        direction: next?.direction ?? direction,
        strategy: next?.strategy ?? strategy,
        align: next?.align ?? align,
      })
      .then((result) => {
      if (!result.ok) {
        setFailure(result.message ?? '没有排成')
        return
      }
      setSelected(undefined)
      // 接口把算好的坐标一起带回来了：直接画上去。这一步不能省——实测里文件写对了，
      // 画布却一个节点都不动。
      if (result.positions !== undefined) {
        setLayoutPositions(new Map(result.positions.map((at) => [at.id, { x: at.x, y: at.y }])))
        setNotice('已重排 ' + String(result.positions.length) + ' 个节点')
      }
      // 排完的坐标可能整片搬到视口外（换成从左到右时尤其明显），必须重框一次。
      setFitTick((prev) => prev + 1)
      void load()
    })
  }, [triage, flow, direction, strategy, align, load])
  /**
   * 拖出一条新连线：把 `分支` 接到某个节点上。
   *
   * 这是「新建分支」的入口——连线之后在属性面板里给它填条件即可。
   */
  const onConnect = useCallback(
    (from: string, to: string) => {
      if (flow === undefined) return
      setFailure('')
      void triage.addFlowEdge({ from, to, flowId: flow.id }).then((result) => {
        if (!result.ok) {
          setFailure(result.message ?? '没有连上')
          return
        }
        void load()
      })
    },
    [triage, flow, load],
  )
  /**
   * 点中一条连线：选中它，属性面板切成「改条件」。
   *
   * 连线 id 是 `from->to#index`，按最后一个 `->` 和 `#` 切——节点 id 里允许有横线。
   */
  /**
   * 新建一条分支：名字 + 条件**一次落盘**，再把那条边选中。
   *
   * 以前是「先起个名 → 建一条**无条件**的边 → 再让你去填条件」。中间那一刻文件里躺着
   * 一条兜底边，它会把后面所有分支都挡掉——新建一条分支顺手改了路由，界面上还会立刻
   * 报「后面还有 N 条永远不会命中」。现在条件跟边一起写，没有这个中间态。
   */
  const createRule = useCallback(
    (name: string, conditions: readonly Readonly<Record<string, unknown>>[]) => {
      if (flow === undefined || flow.trigger === undefined) {
        setFailure('分支只能加在事件流上')
        return
      }
      if (conditions.length === 0) {
        setFailure('先给它一个条件——没有条件的边是兜底，会把后面的分支全挡掉')
        return
      }
      setFailure('')
      /**
       * 从 **switch** 上连出去——「分支」就是干这个的。
       *
       * 不能取「第一个有出边的节点」：那是 `trigger`，它只该有一条通往分支的边。
       * 之前就是这么写的，结果每条分支都在 trigger 上多挂一条，图直接废掉。
       */
      const from =
        flow.nodes.find((item) => item.type === 'switch')?.id ??
        flow.nodes.find((item) => (item.out ?? []).length > 1)?.id ??
        flow.nodes[0]?.id
      if (from === undefined) {
        setFailure('这张图是空的')
        return
      }
      void triage.addRule({ flowId: flow.id, from, name, when: conditions }).then((result) => {
        if (!result.ok) {
          setFailure(result.message ?? '没建成')
          return
        }
        setCreating(undefined)
        // 新边先记下来，等图重载完再由 effect 选中——这里读到的 `flow` 还是旧的。

        if (typeof result.edgeIndex === 'number') setPendingRuleEdge({ from, index: result.edgeIndex })
        void load()
      })
    },
    [triage, flow, load],
  )
  /** 图重载完之后，把新建分支那条边选中——此时才查得到 `edgeSpec`。 */
  useEffect(() => {
    if (pendingRuleEdge === undefined) return
    const from = flow?.nodes.find((item) => item.id === pendingRuleEdge.from)
    if (from?.out?.[pendingRuleEdge.index] === undefined) return
    setSelectedEdge(pendingRuleEdge)
    setPendingRuleEdge(undefined)
  }, [pendingRuleEdge, flow])
  const onEdgeClick = useCallback((edgeId: string) => {
    const hash = edgeId.lastIndexOf('#')
    const arrow = edgeId.lastIndexOf('->', hash)
    if (hash < 0 || arrow < 0) return
    const from = edgeId.slice(0, arrow)
    const index = Number(edgeId.slice(hash + 1))
    if (!Number.isFinite(index)) return
    setSelected(undefined)
    setSelectedEdge({ from, index })
  }, [])
  const onDrill = useCallback(
    (id: string) => {
      const node = flow?.nodes.find((item) => item.id === id)
      const target =
        node?.type === 'workflow' && typeof node.config?.['workflow'] === 'string' ? node.config['workflow'] : undefined
      if (target !== undefined && workflows.some((item) => item.id === target)) {
        setTab('workflows')
        setFlowId(target)
        setSelected(undefined)
        return
      }
      setSelected(id)
    },
    [flow, workflows],
  )
  const onSave = useCallback(() => {
    if (node === undefined) return
    void triage.saveFlowNode({ nodeId: node.id, config: draft }).then((result) => {
      if (!result.ok) {
        setFailure(result.message ?? '没有存下来')
        return
      }
      setFailure('')
      setDirty(false)
      void load()
    })
  }, [node, draft, triage, load])
  if (loading) return <p style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>正在读事件流…</p>
  if (flows.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '22px' }}>
        <p>还没有节点图。</p>
        <p style={{ marginTop: 6 }}>
          现在这份文件是旧格式（旧版规则列表）。把旧版规则一次性转成节点图之后，这里会显示可编排的流程。
        </p>
        {error === '' ? null : <p style={{ marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 0,
        flex: 1,
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
      }}
    >
      {failure === '' ? null : (
        <p role='status' style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>
          {failure}
        </p>
      )}
      {/* 成功了也要说一句：这个按钮之前的问题有一半就是「按下去没有任何动静」——
          坐标没变的时候，人分不清是排好了还是坏了。 */}
      {notice === '' ? null : (
        <p role='status' style={{ fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }}>
          {notice}
        </p>
      )}
      {/* 分支冲突：顺序就是优先级，但两条条件重叠时人看不出来。 */}
      {conflicts.length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '6px 10px',
            borderRadius: 8,
            border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)',
            background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
          }}
        >
          {(showAllConflicts ? conflicts : conflicts.slice(0, 4)).map((conflict, index) => (
            // 一句「第 10 条是无条件兜底，它后面还有 1 条」看不出说的是哪根线：
            // 点一下就选中被挡住的那个分支，画布和右侧面板同时定位过去。
            <button
              key={String(index)}
              type='button'
              onClick={() => {
                setSelected(conflict.second.to)
                setSelectedEdge({ from: conflict.second.nodeId, index: conflict.second.index })
              }}
              title={`点一下去看 ${conflict.second.to}（${conflict.second.nodeId} 的第 ${String(conflict.second.index + 1)} 条出边）`}
              style={{
                fontSize: 11,
                lineHeight: '16px',
                textAlign: 'left',
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
                textDecoration: 'underline dotted',
              }}
            >
              {conflict.reason}
            </button>
          ))}
          {conflicts.length > 4 ? (
            // 「还有 N 处」以前是一句死字：知道还有问题，但看不到是什么问题。
            <button
              type='button'
              onClick={() => { setShowAllConflicts((current) => !current) }}
              style={{
                alignSelf: 'flex-start',
                fontSize: 11,
                lineHeight: '16px',
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary)',
                cursor: 'pointer',
                textDecoration: 'underline dotted',
              }}
            >
              {showAllConflicts
                ? '收起'
                : `还有 ${String(conflicts.length - 4)} 处（点开看）`}
            </button>
          ) : null}
        </div>
      )}
      {/* 两类东西分开看：**事件流**是路由（一个事件一张），**子工作流**是被调用的执行体。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {eventFlows.map((item) => (
          <button
            key={item.id}
            type='button'
            onClick={() => {
              setTab('events')
              setFlowId(item.id)
              setSelected(undefined)
            }}
            style={tabStyle(tab === 'events' && flow?.id === item.id)}
            title={item.trigger === undefined ? '' : '事件 ' + item.trigger}
          >
            事件流 · {item.trigger ?? item.name}
          </button>
        ))}
        <button
          type='button'
          onClick={() => {
            setTab('workflows')
            setFlowId(undefined)
            setSelected(undefined)
          }}
          style={tabStyle(tab === 'workflows')}
        >
          子工作流（{String(workflows.length)}）
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {visibleFlows.length > 1 ? (
          <select
            value={flow?.id ?? ''}
            onChange={(event) => {
              setFlowId(event.target.value)
              setSelected(undefined)
            }}
            style={{
              fontSize: 13,
              padding: '4px 8px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-settings-card-fill)',
              color: 'var(--dsw-alias-label-primary)',
            }}
          >
            {visibleFlows.map((item) => (
              <option key={item.id} value={item.id}>
                {/* 11 张图里哪几张缺开始/结束，在下拉里就该看得出来——
                    否则要一张张点进去才发现「哦，这张还没补端点」。 */}
                {item.name}
                {item.nodes.some((node) => node.type === 'start') && item.nodes.some((node) => node.type === 'end')
                  ? ''
                  : '（缺端点）'}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 500 }}>{flow?.name}</span>
        )}
        {/* 缺端点这件事在下拉里只是括号里的三个字，太容易被划过去；这里给一次补齐。 */}
        {tab === 'workflows' && withoutEndpoints.length > 0 ? (
          <button
            type='button'
            title='每张图先备份成 .bak-scaffold-*，再补上开始/结束；已经有的会跳过'
            onClick={() => {
              void triage.scaffoldFlows().then(async (result) => {
                if (result.ok) {
                  setFailure('')
                  setNotice(result.message ?? '已补齐开始/结束')
                  void load()
                  return
                }
                // 宿主还停在旧版本（插件升级了但进程没重启）时不认「批量」这个动作，
                // 只会回一句 `flowId is required`。逐张接口一直在，退化成一张一张补：
                // 慢一点（每张一次 HTTP），但不用逼人重启整个应用。
                if (/flowId/i.test(result.message ?? '')) {
                  const stuck: string[] = []
                  let done = 0
                  for (const item of withoutEndpoints) {
                    const one = await triage.addFlowScaffold(item.id)
                    if (one.ok) {
                      done += 1
                      continue
                    }
                    stuck.push(item.name)
                  }
                  if (stuck.length > 0) {
                    setFailure(`补了 ${String(done)} 张，没补成：${stuck.join('、')}`)
                    return
                  }
                  setFailure('')
                  setNotice(`已补齐 ${String(done)} 张子工作流的开始/结束（宿主没重启，走的是逐张补）`)
                  void load()
                  return
                }
                setFailure(result.message ?? '没有补上')
              })
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-state-warn-primary)',
              background: 'transparent',
              color: 'var(--dsw-alias-state-warn-primary)',
              cursor: 'pointer',
            }}
          >
            + 全部补齐（{String(withoutEndpoints.length)} 张缺端点）
          </button>
        ) : null}
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {String(flow?.nodes.length ?? 0)} 个节点 · {String(edgeCount)} 条连线 · connector {flow?.connector}
          {/* 冲突数放这儿：冲突条可能被推到画布外面，抬头这一行先把「有没有问题」交代清楚。 */}
          {conflicts.length === 0 ? ' · 没有冲突' : ` · ${String(conflicts.length)} 处冲突`}
          {selected === undefined ? ' · 点一个节点看它的配置，拖动能调位置；选中后 Delete 删除、Esc 取消' : ''}
        </span>
        {/* 自动布局：方向决定流程往哪边走，策略决定松紧。点一下重排并写回文件。 */}
        <select
          value={direction}
          onChange={(event) => {
            const value = event.target.value as LayoutDirection
            setDirection(value)
            onAutoLayout({ direction: value })
          }}
          title='流程走向'
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            padding: '4px 6px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-settings-card-fill)',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <option value='TB'>↓ 自上而下</option>
          <option value='BT'>↑ 自下而上</option>
          <option value='LR'>→ 从左到右</option>
          <option value='RL'>← 从右到左</option>
        </select>
        <select
          value={strategy}
          onChange={(event) => {
            const value = event.target.value as LayoutStrategy
            setStrategy(value)
            onAutoLayout({ strategy: value })
          }}
          title='排列方式'
          style={{
            fontSize: 12,
            padding: '4px 6px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-settings-card-fill)',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <option value='layered'>分层</option>
          <option value='compact'>紧凑</option>
        </select>
        <select
          value={align}
          onChange={(event) => {
            const value = event.target.value as LayoutAlign
            setAlign(value)
            onAutoLayout({ align: value })
          }}
          title='对齐方式'
          style={{
            fontSize: 12,
            padding: '4px 6px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-settings-card-fill)',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <option value='center'>居中</option>
          <option value='start'>左对齐</option>
          <option value='end'>右对齐</option>
        </select>
        <button
          type='button'
          onClick={() => { onAutoLayout() }}
          title='按选的方向和方式重排所有节点'
          style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          }}
        >
          自动布局
        </button>
        <button
          type='button'
          onClick={() => {
            void load()
          }}
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          }}
        >
          重新读取
        </button>
        <button
          type='button'
          onClick={() => {
            setFull((prev) => !prev)
          }}
          title={full ? '退出全屏' : '全屏看这张图'}
          style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          }}
        >
          {full ? '退出全屏' : '全屏'}
        </button>
        <select
          value=''
          onChange={(event) => {
            const type = event.target.value
            if (type === '') return
            void triage
              .addFlowNode({
                type,
                ...(flow === undefined ? {} : { flowId: flow.id }),
                ...(selected === undefined ? {} : { after: selected }),
              })
              .then((result) => {
                if (!result.ok) {
                  setFailure(result.message ?? '没有加进去')
                  return
                }
                setFailure('')
                // 加完直接选中它：右侧面板立刻是它的配置，画布上也有选中框——不然新卡片

                // 只是「多了一个方块」，人还得自己去认是哪个。

                void load().then(() => {
                  if (result.nodeId !== undefined) setSelected(result.nodeId)
                })
              })
            event.target.value = ''
          }}
          title={selected === undefined ? '接在流程末尾（末尾有多个入口时会让你先选一个节点）' : '加在选中节点之后'}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 8,
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-settings-card-fill)',
          }}
        >
          <option value=''>+ 新增节点</option>
          {types.map((type) => (
            <option key={type.type} value={type.type}>
              {type.label}（{type.type}）
            </option>
          ))}
        </select>
        {/* 新建一张独立的子工作流。「+ 新建分支」也能建，但那只在你想让分支命中时才有——
            想把一段可复用的流程先搭出来、之后再接事件，之前没有入口。 */}
        {tab !== 'events' ? (
          creatingFlow === undefined ? (
            <button
              type='button'
              onClick={() => { setCreatingFlow('') }}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 8,
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
              }}
            >
              + 新建子工作流
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                autoFocus
                value={creatingFlow}
                placeholder='名字，比如「退订邮件归档」'
                onChange={(event) => { setCreatingFlow(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && creatingFlow.trim() !== '') {
                    void triage.createFlow(creatingFlow.trim()).then((result) => {
                      if (!result.ok) {
                        setFailure(result.message ?? '没建成')
                        return
                      }
                      setFailure('')
                      setCreatingFlow(undefined)
                      if (result.flowId !== undefined) setFlowId(result.flowId)
                      void load()
                    })
                  }
                  if (event.key === 'Escape') setCreatingFlow(undefined)
                }}
                style={{
                  fontSize: 12,
                  lineHeight: '18px',
                  padding: '4px 8px',
                  width: 200,
                  borderRadius: 8,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-settings-card-fill)',
                  color: 'var(--dsw-alias-label-primary)',
                }}
              />
              <button
                type='button'
                disabled={creatingFlow.trim() === ''}
                onClick={() => {
                  void triage.createFlow(creatingFlow.trim()).then((result) => {
                    if (!result.ok) {
                      setFailure(result.message ?? '没建成')
                      return
                    }
                    setFailure('')
                    setCreatingFlow(undefined)
                    if (result.flowId !== undefined) setFlowId(result.flowId)
                    void load()
                  })
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: creatingFlow.trim() === '' ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-state-business-primary)',
                  color: creatingFlow.trim() === '' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-bg-layer-1)',
                  cursor: creatingFlow.trim() === '' ? 'default' : 'pointer',
                }}
              >
                建
              </button>
              <button
                type='button'
                onClick={() => { setCreatingFlow(undefined) }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
            </div>
          )
        ) : null}
        {flow?.trigger !== undefined ||
        flow?.nodes.some((node) => node.type === 'start') === true ? null : flow?.nodes.some(
            (node) => node.type === 'end',
          ) === true ? (
          <button
            type='button'
            onClick={() => {
              if (flow === undefined) return
              void triage.addFlowScaffold(flow.id).then((result) => {
                if (!result.ok) {
                  setFailure(result.message ?? '没有补上')
                  return
                }
                setFailure('')
                void load()
              })
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            }}
          >
            + 补「开始」
          </button>
        ) : (
          <button
            type='button'
            onClick={() => {
              if (flow === undefined) return
              void triage.addFlowScaffold(flow.id).then((result) => {
                if (!result.ok) {
                  setFailure(result.message ?? '没有补上')
                  return
                }
                setFailure('')
                void load()
              })
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            }}
          >
            + 补「开始 / 结束」
          </button>
        )}
        {/* 新建分支：分支只能挂在事件流上——子工作流里没有「事件」这回事，
            所以那里根本不给按钮，而不是让人点开、填完名字、再吃一句「分支只能加在事件流上」。 */}
        {flow?.trigger === undefined ? null : (
          <button
            type='button'
            onClick={() => {
              setFailure('')
              // 默认给最便宜的那种条件：判类要过一遍模型，不该是新分支的默认值。

              const initial = conditionKinds.includes('from') ? 'from' : (conditionKinds[0] ?? 'from')
              setCreating({ name: '', conditions: [{ kind: initial }] })
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            }}
          >
            + 新建分支
          </button>
        )}
      </div>
      {/* 足迹条：这张图最近跑过的几次，点一次就把画布上的标记换成那一次。
          没有它的时候，画布标的是「全库最新一条有足迹的记录」——换个图看同一次执行，
          标记会整片消失，因为那张图的方块 id 在这条记录里一个都没有。 */}
      {flowRuns.length === 0 ? null : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>足迹</span>
          {flowRuns.slice(0, 8).map((run) => {
            const active = run.id === activeRun?.id
            const at = new Date(run.at)
            const clock = Number.isNaN(at.getTime())
              ? run.at
              : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
            const failed = (run.nodes ?? []).some((node) => !node.ok)
            const subject = typeof run.event?.subject === 'string' ? run.event.subject : ''
            return (
              <button
                key={run.id}
                type='button'
                aria-pressed={active}
                title={`${subject === '' ? run.ruleId : subject}\n命中：${run.ruleName === '' ? run.ruleId : run.ruleName} · ${run.status}`}
                onClick={() => {
                  setTrailRunId(run.id)
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  maxWidth: 220,
                  padding: '2px 7px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: `0.5px solid ${active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'}`,
                  background: active ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  lineHeight: '16px',
                  cursor: 'pointer',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flex: '0 0 auto',
                    background: failed
                      ? 'var(--dsw-alias-state-error-primary)'
                      : 'var(--dsw-alias-state-success-primary)',
                  }}
                />
                <span style={{ flex: '0 0 auto' }}>{clock}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {subject === '' ? run.ruleId : subject}
                </span>
              </button>
            )
          })}
          {flowRuns.length > 8 ? (
            <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
              还有 {String(flowRuns.length - 8)} 次
            </span>
          ) : null}
          {/* 试跑：拿这条执行的那封邮件按当前图再算一次，结论直接标在画布上。 */}
          {activeRun === undefined || activeRun.event.accountId === undefined || activeRun.event.uid === undefined
            ? null
            : (
              <button
                type='button'
                disabled={dry?.pending === true}
                onClick={() => { tryRunAgain(activeRun) }}
                style={{
                  fontSize: 11,
                  lineHeight: '16px',
                  padding: '2px 8px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: dry?.pending === true ? 'default' : 'pointer',
                }}
              >
                {dry?.pending === true ? '试跑中…' : '试跑这条'}
              </button>
            )}
          {dryNow === undefined || dryNow.verdict === '' ? null : (
            <span
              role='status'
              style={{
                fontSize: 11,
                lineHeight: '16px',
                color: dryNow.edgeId === undefined
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-state-business-primary)',
              }}
            >
              {dryNow.verdict}
            </span>
          )}
        </div>
      )}
      <div
        ref={shellRef}
        style={{
          position: 'relative',
          display: 'flex',
          gap: 12,
          alignItems: 'stretch',
          minHeight: 0,
          flex: full ? 1 : undefined,
          height: full ? '100%' : undefined,
          minWidth: 0,
        }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
          <FlowCanvas
            // 坐标变了就整块重建一次。React Flow 内部按 id 复用节点对象，位置只在
            // 「签名变了」时才重设；实测里自动布局把文件写对了、接口也回了坐标，画布
            // 却纹丝不动——与其继续赌那条复用路径，不如让它重新挂载一次。
            key={canvasKey}
            fullscreen={full}
            height={canvasHeight}
            highlightEdge={dryEdgeId}
            nodes={canvasNodes}
            edges={canvas.edges}
            selected={selected}
            onSelect={setSelected}
            onMove={onMove}
            onOpen={onDrill}
            onConnect={onConnect}
            onEdgeClick={onEdgeClick}
            fitToken={fitToken}
          />
        </div>
        {/* 选中连线时，用浮层盖住同一个位置改条件——不动节点面板那套结构。 */}
        {selectedEdge !== undefined && edgeFrom !== undefined ? (
          <aside
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 300,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 10,
              borderRadius: 10,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-1)',
              overflowY: 'auto',
            }}
          >
            <div>
              <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>连线的条件</div>
              <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                {edgeFrom.label ?? edgeFrom.id} →{' '}
                {flow?.nodes.find((item) => item.id === edgeSpec?.to)?.label ?? edgeSpec?.to ?? '(未连接)'}
                {' · 第 '}
                {String((selectedEdge?.index ?? 0) + 1)}
                {' 条出边'}
              </div>
            </div>
            {edgeConditions.map((condition, index) => (
              <ConditionEditor
                key={String(index)}
                condition={condition}
                kinds={conditionKinds}
                onChange={(next) => {
                  setEdgeConditions((prev) => prev.map((item, at) => (at === index ? next : item)))
                }}
                onRemove={() => {
                  setEdgeConditions((prev) => prev.filter((_item, at) => at !== index))
                }}
              />
            ))}
            {edgeConditions.length === 0 ? (
              <p style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                没有条件 = 兜底，前面的都没中就走这条。
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type='button'
                onClick={() => {
                  setEdgeConditions((prev) => [...prev, { kind: conditionKinds[0] ?? 'from' }])
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                }}
              >
                + 条件
              </button>
              <button
                type='button'
                onClick={saveEdge}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: 'pointer',
                }}
              >
                保存条件
              </button>
              {/* 点中一根线，本来就该能在这里把它删掉。以前删线只能绕回源节点、在
                  「去向」列表里找 ×——人在画布上选中的就是这根线，却在那儿找不到它。 */}
              {confirmingEdge === `${selectedEdge.from}#${String(selectedEdge.index)}` ? (
                <>
                  <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                    这条连线会从文件里去掉
                  </span>
                  <button
                    type='button'
                    onClick={() => {
                      setConfirmingEdge(undefined)
                      void triage
                        .relinkFlowEdge({ from: selectedEdge.from, index: selectedEdge.index })
                        .then((result) => {
                          if (!result.ok) {
                            setFailure(result.message ?? '没有删掉')
                            return
                          }
                          setFailure('')
                          setSelectedEdge(undefined)
                          void load()
                        })
                    }}
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 8,
                      border: '0.5px solid var(--dsw-alias-state-error-primary)',
                      background: 'var(--dsw-alias-state-error-primary)',
                      color: 'var(--dsw-alias-bg-layer-1)',
                      cursor: 'pointer',
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type='button'
                    onClick={() => { setConfirmingEdge(undefined) }}
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 8,
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={() => { setConfirmingEdge(`${selectedEdge.from}#${String(selectedEdge.index)}`) }}
                  style={{
                    fontSize: 12,
                    padding: '4px 10px',
                    borderRadius: 8,
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-state-error-primary)',
                    cursor: 'pointer',
                  }}
                >
                  删除这条连线
                </button>
              )}
              <button
                type='button'
                onClick={() => {
                  setSelectedEdge(undefined)
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  cursor: 'pointer',
                }}
              >
                关闭
              </button>
            </div>
          </aside>
        ) : null}
        {/* 新建分支：名字与条件一起攒着，点「建」才落盘——中间不留一条无条件边。 */}
        {creating === undefined ? null : (
          <aside
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 320,
              zIndex: 11,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 10,
              borderRadius: 'var(--dsw-radius-md)',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-1)',
              overflowY: 'auto',
            }}
          >
            <div>
              <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>新建分支</div>
              <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                从「分支」接出去一条新边；条件会跟着边一起写进文件，中间不会出现一条谁都命中的兜底边。
              </div>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>分支名</span>
              <input
                autoFocus
                value={creating.name}
                placeholder='比如 github-do'
                onChange={(event) => {
                  setCreating((prev) => (prev === undefined ? prev : { ...prev, name: event.target.value }))
                }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontSize: 12,
                  lineHeight: '18px',
                  padding: '4px 6px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-settings-card-fill)',
                  color: 'var(--dsw-alias-label-primary)',
                }}
              />
            </label>
            {creating.conditions.map((condition, index) => (
              <ConditionEditor
                key={String(index)}
                condition={condition}
                kinds={conditionKinds}
                onChange={(next) => {
                  setCreating((prev) =>
                    prev === undefined
                      ? prev
                      : { ...prev, conditions: prev.conditions.map((item, at) => (at === index ? next : item)) },
                  )
                }}
                onRemove={() => {
                  setCreating((prev) =>
                    prev === undefined
                      ? prev
                      : { ...prev, conditions: prev.conditions.filter((_item, at) => at !== index) },
                  )
                }}
              />
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type='button'
                onClick={() => {
                  setCreating((prev) =>
                    prev === undefined
                      ? prev
                      : {
                          ...prev,
                          conditions: [
                            ...prev.conditions,
                            { kind: conditionKinds.includes('from') ? 'from' : (conditionKinds[0] ?? 'from') },
                          ],
                        },
                  )
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                }}
              >
                + 条件
              </button>
            </div>
            {creatingIssues.length === 0 ? null : (
              <div role='status' style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {creatingIssues.map((issue) => (
                  <span
                    key={issue}
                    style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-primary)' }}
                  >
                    {issue}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type='button'
                disabled={creatingIssues.length > 0}
                onClick={() => {
                  createRule(creating.name, creating.conditions)
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 12px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: creatingIssues.length > 0 ? 'default' : 'pointer',
                  opacity: creatingIssues.length > 0 ? 0.5 : 1,
                }}
              >
                建
              </button>
              <button
                type='button'
                onClick={() => {
                  setCreating(undefined)
                }}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 'var(--dsw-radius-sm)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </aside>
        )}
        {node === undefined || nodeType === undefined ? null : (
          <aside style={{ width: 300, flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {
              <>
                <div>
                  <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>
                    {node.label ?? nodeType.label}
                  </div>
                  <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                    {node.type} · {nodeType.group}
                    {nodeType.sideEffect ? ' · 有副作用' : ''}
                  </div>
                </div>
                {/* 上次跑成什么样。画布上那个 6px 的圆点在缩到 0.45 时基本看不见，
                  真正想确认结果的人都在这儿看。 */}
                {nodeStep === undefined ? null : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      padding: '6px 8px',
                      borderRadius: 'var(--dsw-radius-sm)',
                      background: 'var(--dsw-alias-bg-layer-3)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: '16px',
                        color: nodeStep.ok
                          ? 'var(--dsw-alias-state-success-primary)'
                          : 'var(--dsw-alias-state-error-primary)',
                      }}
                    >
                      上次跑：{nodeStep.ok ? '成功' : '失败'}
                      {nodeStep.failure === undefined ? '' : `（${nodeStep.failure}）`}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: '16px',
                        color: 'var(--dsw-alias-label-secondary)',
                        wordBreak: 'break-word',
                      }}
                    >
                      {nodeStep.detail}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                    上游（谁连到它）
                  </span>
                  {upstreams.length === 0 ? (
                    // 入口节点本来就没有上游（`trigger` 由事件进来、`start` 由调用方进来），

                    // 说它「是一座走不到的孤岛」只会误导人。

                    node.type === 'trigger' || node.type === 'start' ? (
                      <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                        入口：{node.type === 'start' ? '由调用它的工作流传入' : '由事件进来'}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-primary)' }}>
                        没有人连到它——这是一座走不到的孤岛
                      </span>
                    )
                  ) : (
                    upstreams.map((row) => (
                      <button
                        key={`${row.from.id}-${String(row.index)}`}
                        type='button'
                        title={`第 ${String(row.index + 1)} 条出边 · ${row.text}`}
                        onClick={() => {
                          setSelected(row.from.id)
                          setSelectedEdge(undefined)
                        }}
                        style={{
                          display: 'flex',
                          gap: 6,
                          alignItems: 'baseline',
                          textAlign: 'left',
                          padding: '3px 6px',
                          borderRadius: 'var(--dsw-radius-sm)',
                          border: '0.5px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-secondary)',
                          fontSize: 11,
                          lineHeight: '16px',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ flex: '0 0 auto', color: 'var(--dsw-alias-label-primary)' }}>
                          {labelOf(row.from)}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--dsw-alias-label-tertiary)',
                          }}
                        >
                          {row.text}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                {/* 调用方 vs 被调用方：子工作流的「开始」声明了需要哪些变量，这里能看到
                    自己只传了哪些。以前这层对账只能在运行时撞失败才发现。 */}
                {calling === undefined ? null : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                      它调用的「{calling.name}」需要
                    </span>
                    {calling.needs.length === 0 ? (
                      <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                        没有声明入参
                      </span>
                    ) : (
                      calling.needs.map((need) => (
                        <span
                          key={need.name}
                          style={{
                            fontSize: 11,
                            lineHeight: '16px',
                            color: need.missing
                              ? 'var(--dsw-alias-state-warn-primary)'
                              : 'var(--dsw-alias-label-secondary)',
                          }}
                        >
                          {need.name}
                          {need.required ? '（必填）' : ''}
                          {need.missing ? ' —— 这里没传，跑到它会停在「缺少入参」' : ''}
                        </span>
                      ))
                    )}
                  </div>
                )}
                {node.out === undefined || node.out.length === 0 ? null : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                      {(node.out?.length ?? 0) > 1
                        ? '分支（从上往下判定，第一个成立的赢；标「兜底」的行没有条件，排在它后面的一律走不到）'
                        : '去向（换下拉就改连线，× 删掉它，下面「+ 连到…」是新增）'}
                    </span>
                    {node.out.map((edge, index) => {
                      const condition = conditionsOf(edge)
                      const chosen = selectedEdge?.from === node.id && selectedEdge.index === index
                      const edgeCount = node.out?.length ?? 0
                      const move = (direction: 'up' | 'down'): void => {
                        void triage
                          .moveFlowEdge({
                            from: node.id,
                            index,
                            direction,
                            ...(flow === undefined ? {} : { flowId: flow.id }),
                          })
                          .then((result) => {
                            if (!result.ok) {
                              setFailure(result.message ?? '没有挪动')
                              return
                            }
                            setFailure('')
                            setNotice(result.message ?? '已调整顺序')
                            void load()
                          })
                      }
                      return (
                        <div
                          key={`${edge.to}-${String(index)}`}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 3,
                            padding: '4px 6px',
                            borderRadius: 'var(--dsw-radius-sm)',
                            border: `0.5px solid ${chosen ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'}`,
                          }}
                        >
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                            <span style={{ fontSize: 10, flex: 'none', color: 'var(--dsw-alias-label-tertiary)' }}>
                              {String(index + 1)}
                            </span>
                            {/* 条件就是「这条分支凭什么进来」，点一下直接去改它——
                                以前只有画布上那根细线能点，线一多就点不准。 */}
                            <button
                              type='button'
                              title='点这里改这条出边的条件'
                              onClick={() => {
                                setSelectedEdge({ from: node.id, index })
                              }}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                textAlign: 'left',
                                fontSize: 11,
                                lineHeight: '16px',
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                color:
                                  condition === '兜底'
                                    ? 'var(--dsw-alias-state-warn-primary)'
                                    : 'var(--dsw-alias-label-primary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {condition}
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <select
                              value={edge.to}
                              onChange={(event) => {
                                const to = event.target.value
                                if (to === edge.to) return
                                void triage.relinkFlowEdge({ from: node.id, index, to }).then((result) => {
                                  if (!result.ok) {
                                    setFailure(result.message ?? '没有改成功')
                                    return
                                  }
                                  setFailure('')
                                  void load()
                                })
                              }}
                              style={{
                                flex: 1,
                                fontSize: 12,
                                padding: '3px 6px',
                                borderRadius: 6,
                                border: '0.5px solid var(--dsw-alias-border-l2)',
                                background: 'var(--dsw-alias-settings-card-fill)',
                              }}
                            >
                              {flow?.nodes
                                .filter((item) => item.id !== node.id)
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {labelOf(item)}
                                  </option>
                                ))}
                            </select>
                            {edgeCount > 1 ? (
                              <>
                                <button
                                  type='button'
                                  title='往上挪一位（提高优先级）'
                                  disabled={index === 0}
                                  onClick={() => {
                                    move('up')
                                  }}
                                  style={{
                                    fontSize: 11,
                                    padding: '2px 6px',
                                    borderRadius: 6,
                                    border: '0.5px solid var(--dsw-alias-border-l2)',
                                    background: 'transparent',
                                    color: 'var(--dsw-alias-label-secondary)',
                                    cursor: index === 0 ? 'default' : 'pointer',
                                    opacity: index === 0 ? 0.4 : 1,
                                  }}
                                >
                                  ↑
                                </button>
                                <button
                                  type='button'
                                  title='往下挪一位（降低优先级）'
                                  disabled={index === edgeCount - 1}
                                  onClick={() => {
                                    move('down')
                                  }}
                                  style={{
                                    fontSize: 11,
                                    padding: '2px 6px',
                                    borderRadius: 6,
                                    border: '0.5px solid var(--dsw-alias-border-l2)',
                                    background: 'transparent',
                                    color: 'var(--dsw-alias-label-secondary)',
                                    cursor: index === edgeCount - 1 ? 'default' : 'pointer',
                                    opacity: index === edgeCount - 1 ? 0.4 : 1,
                                  }}
                                >
                                  ↓
                                </button>
                              </>
                            ) : null}
                            <button
                              type='button'
                              title='删掉这条出边'
                              onClick={() => {
                                void triage.relinkFlowEdge({ from: node.id, index }).then((result) => {
                                  if (!result.ok) {
                                    setFailure(result.message ?? '没有删掉')
                                    return
                                  }
                                  setFailure('')
                                  void load()
                                })
                              }}
                              style={{
                                fontSize: 11,
                                padding: '2px 8px',
                                borderRadius: 6,
                                border: '0.5px solid var(--dsw-alias-border-l2)',
                                background: 'transparent',
                                cursor: 'pointer',
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    {/* 加一条出边。以前这事只有一种做法：从端点上拖出一根线——拖不动就
                        永远连不上第二个分支。这里给一条不用拖的路。 */}
                    <select
                      value=''
                      aria-label='加一条出边'
                      title='加一条出边（不用拖线）'
                      onChange={(event) => {
                        const to = event.target.value
                        if (to === '') return
                        void triage.addFlowEdge({ from: node.id, to, ...(flow === undefined ? {} : { flowId: flow.id }) }).then((result) => {
                          if (!result.ok) {
                            setFailure(result.message ?? '没有连上')
                            return
                          }
                          setFailure('')
                          setNotice('已加一条出边')
                          void load()
                        })
                      }}
                      style={{
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 6,
                        border: '0.5px dashed var(--dsw-alias-border-l2)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      <option value=''>+ 连到…</option>
                      {flow?.nodes
                        .filter((item) => item.id !== node.id && (node.out ?? []).every((edge) => edge.to !== item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {labelOf(item)}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
                  {Object.entries(nodeType.config ?? {}).map(([name, spec]) => (
                    <Field
                      key={name}
                      name={name}
                      spec={spec}
                      value={draft[name]}
                      onChange={(value) => {
                        setDirty(true)
                        setDraft((prev) => {
                          const next = { ...prev }
                          if (value === undefined) delete next[name]
                          else next[name] = value
                          return next
                        })
                      }}
                    />
                  ))}
                  {Object.keys(nodeType.config ?? {}).length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>这种节点没有可填的字段。</p>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type='button'
                    onClick={onSave}
                    disabled={!dirty}
                    style={{
                      fontSize: 13,
                      padding: '6px 14px',
                      borderRadius: 8,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '0.5px solid var(--dsw-alias-state-business-primary)',
                      background: dirty ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                      color: 'var(--dsw-alias-state-business-primary)',
                      opacity: dirty ? 1 : 0.5,
                    }}
                  >
                    保存这个节点
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      setDraft(node.config === undefined ? {} : { ...node.config })
                      setDirty(false)
                    }}
                    disabled={!dirty}
                    style={{
                      fontSize: 13,
                      padding: '6px 14px',
                      borderRadius: 8,
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'transparent',
                      cursor: dirty ? 'pointer' : 'default',
                      opacity: dirty ? 1 : 0.5,
                    }}
                  >
                    撤销改动
                  </button>
                </div>
                {confirmingDelete === node.id ? (
                  <>
                    {/* 删掉的不只是这一个方块：它的入边出边一起从文件里没了，配置也回不来。 */}
                    <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                      它的连线会一起从文件里去掉，配置也回不来
                    </span>
                    <button
                      type='button'
                      onClick={() => {
                        setConfirmingDelete(undefined)
                        void triage.removeFlowNode(node.id).then((result) => {
                          if (!result.ok) {
                            setFailure(result.message ?? '没有删掉')
                            return
                          }
                          setFailure('')
                          setSelected(undefined)
                          void load()
                        })
                      }}
                      style={{
                        fontSize: 12,
                        padding: '5px 12px',
                        borderRadius: 8,
                        border: '0.5px solid var(--dsw-alias-state-error-primary)',
                        background: 'var(--dsw-alias-state-error-primary)',
                        color: 'var(--dsw-alias-bg-layer-1)',
                        cursor: 'pointer',
                      }}
                    >
                      确认删除
                    </button>
                    <button
                      type='button'
                      onClick={() => { setConfirmingDelete(undefined) }}
                      style={{
                        fontSize: 12,
                        padding: '5px 12px',
                        borderRadius: 8,
                        border: '0.5px solid var(--dsw-alias-border-l2)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type='button'
                    onClick={() => { setConfirmingDelete(node.id) }}
                    style={{
                      fontSize: 12,
                      padding: '5px 12px',
                      borderRadius: 8,
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-state-error-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    删除这个节点
                  </button>
                )}
              </>
            }
          </aside>
        )}
      </div>
    </div>
  )
}


