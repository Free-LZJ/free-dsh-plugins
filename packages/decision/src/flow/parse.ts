/**
 * 把 YAML 读成节点图。
 *
 * **只认 `version: 2`。** 旧的 `version: 1`（规则列表 + `then` 数组）不再有读路径：
 * 它由一次性脚本 `scripts/migrate-rules-v2.ts` 转成 v2，转完那种格式就从世界上消失。
 * 保留兼容读会让「在 v1 里改的规则」与「v2 的图」互相过期，而哪边是真相只能靠记忆——
 * 所以这里遇到 v1 直接报错并指向迁移脚本。
 *
 * 校验分两档：
 *
 * - **拒绝整份**：结构不对（顶层不是对象、version 不是 2、flow 不是数组）。这种时候
 *   没有「一部分能用」可言。
 * - **丢弃单条**：某个节点写歪（缺 id、type 不认识、边指向不存在的节点）。一份 20 个
 *   节点的图里坏一个，用户要的是另外 19 个继续工作，而不是整张图不可用。
 *
 * @module @free-lzj/dsh-decision/flow/parse
 */

import { parseDocument, type Document } from 'yaml'
import { isRecord, text, type RuleVocabulary } from '../config.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import type { RuleFileError } from '../types.ts'
import type { FlowNodeRegistry } from './registry.ts'
import type { Flow, FlowEdgeSpec, FlowNodeSpec } from './types.ts'

/** 解析结果。 */
export interface ParsedFlows {
  /** 解析出来的图；出错时为空。 */
  readonly flows: readonly Flow[]
  /** 结构错误；此时 `flows` 为空且引擎会保留上一份可用图。 */
  readonly error?: RuleFileError
  /** 被丢弃的节点/边说明，给人看。 */
  readonly dropped: readonly string[]
  /**
   * 文件是旧格式（version: 1）。
   *
   * 与「文件坏了」区分开：迁移完成前 v1 是**合法**的过渡状态，引擎不该为此告警。
   */
  readonly legacy?: boolean
}

/** 一份文件合法的版本号。 */
export const FLOW_VERSION = 2

/**
 * 读一个「单图文件」：文件本身就是一个 Flow，没有 lows: 包一层。
 *
 * 一规则一文件之后这是**唯一的形状**——一份文件就是一张图，谁在哪儿一目了然，
 * 也不用在一份大文件里找「第 3 张图的第 7 个节点」。
 * @param source - 文件原文。
 * @param registry - 已注册的节点类型。
 * @param vocabulary - 连接器词表。
 * @returns 图，或错误与丢弃说明。
 */
export function parseFlowDocument(
  source: string,
  registry: FlowNodeRegistry,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
): { readonly flow?: Flow; readonly error?: RuleFileError; readonly dropped: readonly string[] } {
  let document: Document
  try {
    document = parseDocument(source)
  } catch (error: unknown) {
    return { dropped: [], error: { message: yamlError(error) } }
  }
  if (document.errors.length > 0) {
    const first = document.errors[0]
    const line = first?.linePos?.[0]?.line
    return {
      dropped: [],
      error: { message: first?.message ?? 'YAML 语法错误', ...(line === undefined ? {} : { line }) },
    }
  }
  const root: unknown = document.toJS()
  if (!isRecord(root)) return { dropped: [], error: { message: '图文件的顶层必须是一个对象' } }
  if (Array.isArray(root['flows'])) {
    return { dropped: [], error: { message: '这是合集文件（有 flows 数组）；一规则一文件时每个文件直接写一张图' } }
  }
  const dropped: string[] = []
  const flow = readFlow(root, 0, undefined, registry, vocabulary, dropped)
  if (flow === undefined) {
    return { dropped, error: { message: '这个文件算不出一张可用的图：' + dropped.join('；') } }
  }
  return { flow, dropped }
}

/**
 * 把一段文本读成图。
 * @param source - 文件原文。
 * @param registry - 已注册的节点类型；用来判「这个 type 认不认识」。
 * @param vocabulary - 连接器词表；用来收窄边上的条件。
 * @returns 解析结果。
 */
export function parseFlowFile(
  source: string,
  registry: FlowNodeRegistry,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
): ParsedFlows {
  let document: Document
  try {
    document = parseDocument(source)
  } catch (error: unknown) {
    return { flows: [], dropped: [], error: { message: yamlError(error) } }
  }
  if (document.errors.length > 0) {
    const first = document.errors[0]
    const line = first?.linePos?.[0]?.line
    return {
      flows: [],
      dropped: [],
      error: { message: first?.message ?? 'YAML 语法错误', ...(line === undefined ? {} : { line }) },
    }
  }

  const root: unknown = document.toJS()
  if (!isRecord(root)) {
    return { flows: [], dropped: [], error: { message: '规则文件的顶层必须是一个对象' } }
  }

  const version = root['version']
  if (version === 1) {
    return {
      flows: [],
      dropped: [],
      legacy: true,
      error: {
        message: '这是旧格式（version: 1）。请先运行 scripts/migrate-rules-v2.ts 转成 version: 2；'
          + '本版本不再读取旧格式。',
      },
    }
  }
  if (version !== FLOW_VERSION) {
    return {
      flows: [],
      dropped: [],
      error: { message: `不认识的规则文件版本 ${String(version)}；这一版只接受 version: ${String(FLOW_VERSION)}` },
    }
  }

  const rawFlows = root['flows']
  if (!Array.isArray(rawFlows)) {
    return { flows: [], dropped: [], error: { message: 'version: 2 的文件必须有 flows 数组' } }
  }

  // 文件顶层的 connector 是缺省归属；单张 flow 可以覆盖它。
  const fileConnector = text(root['connector'])
  const dropped: string[] = []
  const flows: Flow[] = []
  const seenFlowIds = new Set<string>()

  for (const [index, rawFlow] of rawFlows.entries()) {
    const flow = readFlow(rawFlow, index, fileConnector, registry, vocabulary, dropped)
    if (flow === undefined) continue
    if (seenFlowIds.has(flow.id)) {
      dropped.push(`第 ${String(index + 1)} 张流程的 id「${flow.id}」重复，已跳过`)
      continue
    }
    seenFlowIds.add(flow.id)
    flows.push(flow)
  }

  return { flows, dropped }
}

/**
 * 读一张流程。
 * @returns 图，或 undefined（这张不可用）。
 */
function readFlow(
  raw: unknown,
  index: number,
  fileConnector: string | undefined,
  registry: FlowNodeRegistry,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
  dropped: string[],
): Flow | undefined {
  const position = index + 1
  if (!isRecord(raw)) {
    dropped.push(`第 ${String(position)} 张流程不是对象，已跳过`)
    return undefined
  }
  const id = text(raw['id'])
  if (id === undefined) {
    dropped.push(`第 ${String(position)} 张流程缺 id，已跳过`)
    return undefined
  }
  const connector = text(raw['connector']) ?? fileConnector
  if (connector === undefined) {
    dropped.push(`流程「${id}」没有写 connector，它永远不会执行，已跳过`)
    return undefined
  }
  const rawNodes = raw['nodes']
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    dropped.push(`流程「${id}」没有 nodes，已跳过`)
    return undefined
  }

  const nodes: FlowNodeSpec[] = []
  const seen = new Set<string>()
  for (const [nodeIndex, rawNode] of rawNodes.entries()) {
    const node = readNode(rawNode, id, nodeIndex, registry, vocabulary, dropped)
    if (node === undefined) continue
    if (seen.has(node.id)) {
      dropped.push(`流程「${id}」里的节点 id「${node.id}」重复，已跳过后一个`)
      continue
    }
    seen.add(node.id)
    nodes.push(node)
  }
  if (nodes.length === 0) {
    dropped.push(`流程「${id}」一个可用的节点都没有，已跳过`)
    return undefined
  }

  // 边指向必须存在。悬空边**整张图拒绝**：它意味着少了东西，跑起来只会走到一半停住。
  const ids = new Set(nodes.map(node => node.id))
  const dangling: string[] = []
  for (const node of nodes) {
    for (const edge of node.out ?? []) {
      if (!ids.has(edge.to)) dangling.push(`${node.id} → ${edge.to}`)
    }
  }
  if (dangling.length > 0) {
    dropped.push(`流程「${id}」有边指向不存在的节点：${dangling.join('、')}；整张图已跳过`)
    return undefined
  }

  // 环只允许出现在 loop 体内；这一版还没有 loop 节点，所以整图必须是 DAG。
  const cycle = findCycle(nodes)
  if (cycle !== undefined) {
    dropped.push(`流程「${id}」有环：${cycle.join(' → ')}；整张图已跳过`)
    return undefined
  }

  return { id, name: text(raw['name']) ?? id, connector, nodes }
}

/** 读一个节点。 */
function readNode(
  raw: unknown,
  flowId: string,
  index: number,
  registry: FlowNodeRegistry,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
  dropped: string[],
): FlowNodeSpec | undefined {
  const where = `流程「${flowId}」第 ${String(index + 1)} 个节点`
  if (!isRecord(raw)) {
    dropped.push(`${where}不是对象，已跳过`)
    return undefined
  }
  const id = text(raw['id'])
  if (id === undefined) {
    dropped.push(`${where}缺 id，已跳过`)
    return undefined
  }
  const type = text(raw['type'])
  if (type === undefined) {
    dropped.push(`节点「${id}」缺 type，已跳过`)
    return undefined
  }
  if (!registry.has(type)) {
    // 不认识的 type 保留节点、标成禁用：整图还能看，执行到它时记 config 失败。
    // 直接丢弃会让「一个 type 拼错」表现为「这张图少了一块」，更难查。
    dropped.push(`节点「${id}」的类型「${type}」没有注册，已标记为禁用`)
    return {
      id,
      type,
      enabled: false,
      ...(isRecord(raw['config']) ? { config: raw['config'] } : {}),
      ...(text(raw['label']) === undefined ? {} : { label: text(raw['label']) as string }),
    }
  }

  const out = readEdges(raw['out'], id, vocabulary, dropped)
  const body = readBody(raw['body'], id, registry, vocabulary, dropped)
  const pos = readPos(raw['pos'])
  const runner = text(raw['runner'])
  const label = text(raw['label'])

  return {
    id,
    type,
    ...(isRecord(raw['config']) ? { config: raw['config'] } : {}),
    ...(out === undefined ? {} : { out }),
    ...(runner === undefined ? {} : { runner }),
    ...(pos === undefined ? {} : { pos }),
    ...(raw['enabled'] === false ? { enabled: false } : {}),
    ...(label === undefined ? {} : { label }),
    ...(body === undefined ? {} : { body }),
  }
}

/**
 * 读复合节点的子图。
 *
 * 子图里的节点**不参与主图的边校验**——它们只在承载它的节点执行时才有意义，所以
 * 单独递归读一遍，填错了就当没有子图（那会让 loop 在执行时报「没有循环体」，
 * 位置很明确）。
 */
function readBody(
  raw: unknown,
  nodeId: string,
  registry: FlowNodeRegistry,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
  dropped: string[],
): { readonly nodes: readonly FlowNodeSpec[] } | undefined {
  if (!isRecord(raw) || !Array.isArray(raw['nodes'])) return undefined
  const nodes: FlowNodeSpec[] = []
  for (const [index, item] of raw['nodes'].entries()) {
    const read = readNode(item, nodeId + ' 的循环体', index, registry, vocabulary, dropped)
    if (read !== undefined) nodes.push(read)
  }
  return nodes.length === 0 ? undefined : { nodes }
}

/** 读出边；写歪的一条单独丢，其余保留。 */
function readEdges(
  raw: unknown,
  nodeId: string,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
  dropped: string[],
): readonly FlowEdgeSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const edges: FlowEdgeSpec[] = []
  for (const [index, rawEdge] of raw.entries()) {
    if (!isRecord(rawEdge)) {
      dropped.push(`节点「${nodeId}」的第 ${String(index + 1)} 条出边不是对象，已跳过`)
      continue
    }
    const to = text(rawEdge['to'])
    if (to === undefined) {
      dropped.push(`节点「${nodeId}」的第 ${String(index + 1)} 条出边缺 to，已跳过`)
      continue
    }
    const when = readConditions(rawEdge['when'], nodeId, vocabulary, dropped)
    edges.push({
      to,
      ...(when === undefined ? {} : { when }),
      ...(rawEdge['mode'] === 'fork' ? { mode: 'fork' as const } : {}),
    })
  }
  return edges.length === 0 ? undefined : edges
}

/** 读一组条件；认不出的单条丢并说明。 */
function readConditions(
  raw: unknown,
  nodeId: string,
  vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>,
  dropped: string[],
): readonly ConditionSpecLike[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const conditions: ConditionSpecLike[] = []
  for (const item of raw) {
    const parsed = vocabulary.normalizeCondition(item)
    if (parsed === undefined) {
      dropped.push(`节点「${nodeId}」的一条出边条件写歪了，已跳过`)
      continue
    }
    conditions.push(parsed)
  }
  return conditions.length === 0 ? undefined : conditions
}

/** 读坐标；非法值忽略（它是渲染信息，不值得为它拒绝一张图）。 */
function readPos(raw: unknown): { x: number; y: number } | undefined {
  if (!isRecord(raw)) return undefined
  const x = raw['x']
  const y = raw['y']
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x, y }
}

/** 有向图找环；返回一条环路，或 undefined。 */
function findCycle(nodes: readonly FlowNodeSpec[]): readonly string[] | undefined {
  const graph = new Map<string, readonly string[]>()
  for (const node of nodes) graph.set(node.id, (node.out ?? []).map(edge => edge.to))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []

  const walk = (id: string): readonly string[] | undefined => {
    if (visiting.has(id)) {
      const at = stack.indexOf(id)
      return [...stack.slice(at === -1 ? 0 : at), id]
    }
    if (done.has(id)) return undefined
    visiting.add(id)
    stack.push(id)
    for (const next of graph.get(id) ?? []) {
      const found = walk(next)
      if (found !== undefined) return found
    }
    stack.pop()
    visiting.delete(id)
    done.add(id)
    return undefined
  }

  for (const node of nodes) {
    const found = walk(node.id)
    if (found !== undefined) return found
  }
  return undefined
}

/** 把抛出物写成一句话。 */
function yamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
