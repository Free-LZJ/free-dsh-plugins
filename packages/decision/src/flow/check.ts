/**
 * 声明校验：节点的入参/出参有没有对上。
 *
 * 这一层**只在保存时跑**，不拦加载：现有文件里没写声明是合法的过渡状态，一打开面板
 * 就整张图不可用只会把人挡在门外。保存时校验才有意义——那时人正在改这张图，报错能
 * 立刻被看到并修掉。
 *
 * 规则只有三条：
 *
 * 1. 每个节点从上下文取用的名字（`config` 里的 `{占位符}`、`workflow.pass`、
 *    `end.outputs`）都必须在它的 `inputs` 里声明。**出边条件的 `field` 不算**：
 *    它由条件求值器自己从事件/正文取（`body` 就是它拉正文，不经过上下文）。
 * 2. 每条 `inputs` 的引用必须解析得开：`event.<k>` 要有 trigger 声明出参、
 *    `flow.<k>` 要有流程常量/入参、`<nodeId>.<k>` 要是**上游**节点且它声明了出参。
 * 3. 入参的键必须与引用末段同名（`subject: event.subject`）——执行期模板直接读
 *    `vars[键]`，同名保证声明不改变运行期行为。
 *
 * @module @free-lzj/dsh-decision/flow/check
 */

import type { FlowNodeRegistry } from './registry.ts'
import type { Flow, FlowNodeSpec } from './types.ts'

/** 一条校验问题。 */
export interface FlowCheckIssue {
  readonly nodeId: string
  readonly message: string
}

/** 校验结果。 */
export interface FlowCheckResult {
  readonly ok: boolean
  readonly issues: readonly FlowCheckIssue[]
}

/** 引用表达式：`event.x` / `flow.x` / `<nodeId>.x`。 */
export interface NodeInputRef {
  readonly scope: 'event' | 'flow' | 'node'
  /** `node` 时的节点 id。 */
  readonly nodeId?: string
  readonly key: string
}

/**
 * 解析一条引用表达式。
 * @param value - 形如 `event.subject`。
 * @returns 解析结果；写法不合法时 undefined。
 */
export function parseInputRef(value: string): NodeInputRef | undefined {
  const text = value.trim()
  const dot = text.indexOf('.')
  if (dot <= 0 || dot === text.length - 1) return undefined
  const head = text.slice(0, dot)
  const key = text.slice(dot + 1)
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return undefined
  if (head === 'event' || head === 'flow') return { scope: head, key }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(head)) return undefined
  return { scope: 'node', nodeId: head, key }
}

/** 节点声明的出参键：`spec.outputs` 优先，缺省取节点类型的 `outputs`。 */
export function declaredOutputs(node: FlowNodeSpec, registry: FlowNodeRegistry): ReadonlySet<string> {
  const own = node.outputs === undefined ? undefined : Object.keys(node.outputs)
  if (own !== undefined && own.length > 0) return new Set(own)
  const type = registry.get(node.type)
  return new Set((type?.outputs ?? []).map(spec => spec.key))
}

/** 深遍历一个值，收集所有 `{name}` 占位符。 */
function placeholders(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = match[1]
      if (name !== undefined) into.add(name)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) placeholders(item, into)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) placeholders(item, into)
  }
}

/** 节点的上游集合（按出边反向可达）。 */
function ancestorsOf(nodes: readonly FlowNodeSpec[]): ReadonlyMap<string, ReadonlySet<string>> {
  const incoming = new Map<string, Set<string>>()
  for (const node of nodes) incoming.set(node.id, new Set())
  for (const node of nodes) {
    for (const edge of node.out ?? []) {
      incoming.get(edge.to)?.add(node.id)
    }
  }
  const result = new Map<string, ReadonlySet<string>>()
  for (const node of nodes) {
    const seen = new Set<string>()
    const stack = [...(incoming.get(node.id) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const up of incoming.get(id) ?? []) stack.push(up)
    }
    result.set(node.id, seen)
  }
  return result
}

/** 流程级命名空间：`flow.params` 与 `start` 节点 `config.params` 的并集。 */
function flowKeysOf(flow: Flow): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const param of flow.params ?? []) keys.add(param.name)
  for (const node of flow.nodes) {
    if (node.type !== 'start') continue
    const raw = node.config?.['params']
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (typeof item === 'string') keys.add(item)
      else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        keys.add((item as { name: string }).name)
      }
    }
  }
  return keys
}

/**
 * 校验一张图。
 * @param flow - 图。
 * @param registry - 节点类型表（用来取类型声明的出参）。
 * @returns 结果；`ok: false` 时 `issues` 每条都能直接给人看。
 */
export function checkFlow(flow: Flow, registry: FlowNodeRegistry): FlowCheckResult {
  const issues: FlowCheckIssue[] = []
  const flowKeys = flowKeysOf(flow)
  const ancestors = ancestorsOf(flow.nodes)
  const byId = new Map(flow.nodes.map(node => [node.id, node]))

  // trigger 的出参就是事件字段的权威来源；子工作流没有 trigger，事件字段一律走 flow。
  const eventKeys = new Set<string>()
  for (const node of flow.nodes) {
    if (node.type !== 'trigger') continue
    for (const key of declaredOutputs(node, registry)) eventKeys.add(key)
  }

  const checkNode = (node: FlowNodeSpec, inBody: boolean): void => {
    const inputs = node.inputs ?? {}
    const where = inBody ? `节点「${node.id}」（子图）` : `节点「${node.id}」`

    // 1. 引用解析
    for (const [key, raw] of Object.entries(inputs)) {
      const ref = parseInputRef(raw)
      if (ref === undefined) {
        issues.push({ nodeId: node.id, message: `${where}的入参「${key}」写成「${raw}」，引用只认 event.x / flow.x / 节点id.x` })
        continue
      }
      if (ref.key !== key) {
        issues.push({ nodeId: node.id, message: `${where}的入参「${key}」引用「${raw}」末段不同名；请改成 ${raw.split('.')[0]}.${key}` })
        continue
      }
      if (ref.scope === 'event' && !eventKeys.has(ref.key)) {
        issues.push({ nodeId: node.id, message: `${where}引用了事件字段「${ref.key}」，但 trigger 节点没有声明这个出参` })
      }
      if (ref.scope === 'flow' && !flowKeys.has(ref.key)) {
        issues.push({ nodeId: node.id, message: `${where}引用了流程常量「${ref.key}」，但 flow.params 与 start.params 都没声明它` })
      }
      if (ref.scope === 'node') {
        const source = ref.nodeId === undefined ? undefined : byId.get(ref.nodeId)
        if (source === undefined) {
          issues.push({ nodeId: node.id, message: `${where}引用的节点「${String(ref.nodeId)}」不存在` })
        } else if (!(ancestors.get(node.id)?.has(source.id) ?? false)) {
          issues.push({ nodeId: node.id, message: `${where}引用了「${source.id}」的出参，但它不是上游节点` })
        } else if (!declaredOutputs(source, registry).has(ref.key)) {
          issues.push({ nodeId: node.id, message: `${where}引用了「${source.id}.${ref.key}」，但那个节点没有声明这个出参` })
        }
      }
    }

    // 2. 用到的名字必须在入参里声明
    const used = new Set<string>()
    placeholders(node.config, used)
    if (node.type === 'workflow') {
      const pass = node.config?.['pass']
      if (Array.isArray(pass)) for (const item of pass) if (typeof item === 'string') used.add(item)
    }
    if (node.type === 'end') {
      const out = node.config?.['outputs']
      if (Array.isArray(out)) for (const item of out) if (typeof item === 'string') used.add(item)
    }
    for (const name of used) {
      if (name in inputs) continue
      issues.push({ nodeId: node.id, message: `${where}用了「${name}」，但没在入参里声明来源` })
    }

    // 3. start 的必填入参应该有人用；不用只是浪费，不拦。

    for (const child of node.body?.nodes ?? []) checkNode(child, true)
  }

  for (const node of flow.nodes) checkNode(node, false)
  return { ok: issues.length === 0, issues }
}

/** 把校验问题拼成一句给人看的话。 */
export function describeIssues(issues: readonly FlowCheckIssue[]): string {
  return issues.map(issue => issue.message).join('；')
}
