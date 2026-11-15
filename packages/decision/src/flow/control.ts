/**
 * 内置控制流节点：分支、扇出、汇合、终止。
 *
 * **条件求值从上下文来**（`FlowContext.evaluate`），因为这些条件属于连接器——核心不知道
 * 「邮件的 from 条件长什么样」。控制流节点只负责「问一句，然后选哪条边」。
 *
 * 汇合不需要节点实现：执行器要求一个节点的**所有入边都满足**才放它进就绪队列，所以
 * `join` 只是一个空操作的落点，它的语义由边决定。同理 `parallel` 只是扇出的落点，
 * 真正的并行来自出边上的 `mode: 'fork'`。
 *
 * @module @free-lzj/dsh-decision/flow/control
 */

import type { FlowContext, FlowNode, FlowNodeSpec, NodeResult } from './types.ts'

/** 一个空操作：什么都不做，只让流程继续。 */
function passThrough(type: string, label: string, group: 'control' | 'trigger' = 'control'): FlowNode {
  return {
    type,
    label,
    group,
    sideEffect: false,
    config: {},
    async run(): Promise<NodeResult> {
      return { ok: true, detail: label }
    },
  }
}

/** 取条件求值器；没接时判「不成立」而不是崩。 */
async function evaluate(
  context: FlowContext,
  when: readonly { readonly kind: string }[] | undefined,
): Promise<boolean> {
  if (when === undefined || when.length === 0) return false
  const evaluator = context.evaluate
  if (evaluator === undefined) return false
  return await evaluator(when as never, context)
}

/**
 * `switch`：按顺序问每条带条件的出边，第一条成立的胜出；都不成立走无条件那条。
 *
 * **顺序即优先级**——这就是原来 `priority` 排序想表达的东西，现在写在边上看得见。
 */
const switchNode: FlowNode = {
  type: 'switch',
  label: '分支',
  group: 'control',
  sideEffect: false,
  config: {},
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const edges = spec.out ?? []
    for (const edge of edges) {
      if (edge.when === undefined || edge.when.length === 0) continue
      if (await evaluate(context, edge.when)) {
        return { ok: true, detail: `走 ${edge.to}`, next: [edge.to] }
      }
    }
    const fallback = edges.find(edge => edge.when === undefined || edge.when.length === 0)
    if (fallback === undefined) {
      // 没有兜底边：这一轮到此为止。不是错误——「谁都不匹配」是合法结果。
      return { ok: true, detail: '没有分支命中', next: [] }
    }
    return { ok: true, detail: `兜底 ${fallback.to}`, next: [fallback.to] }
  },
}

/**
 * `if`：两出一进的小开关，`switch` 的语法糖。
 *
 * 支持它是因为最常见的分支只有两条，写成 switch 要多带一个 `when` 数组。
 */
const ifNode: FlowNode = {
  type: 'if',
  label: '条件',
  group: 'control',
  sideEffect: false,
  config: {},
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const edges = spec.out ?? []
    const then = edges.find(edge => edge.when !== undefined && edge.when.length > 0)
    const otherwise = edges.find(edge => edge.when === undefined || edge.when.length === 0)
    if (then !== undefined && await evaluate(context, then.when)) {
      return { ok: true, detail: `成立 → ${then.to}`, next: [then.to] }
    }
    if (otherwise !== undefined) return { ok: true, detail: `不成立 → ${otherwise.to}`, next: [otherwise.to] }
    return { ok: true, detail: '不成立且没有 else 边', next: [] }
  },
}

/** 一轮循环最多跑几次；配置写多大都不突破。 */
const MAX_ITERATIONS = 100

/**
 * `loop`：把一段子图跑若干轮。
 *
 * `times` 与 `until` 二选一：前者定轮数，后者每轮跑完问一句「可以停了吗」。
 * 两个都不写就按一次算——一个什么都不循环的循环节点比报错更难查。
 *
 * **硬上限 100 轮**：`until` 写错了不该让引擎转一晚上。超了就按失败收尾并说明。
 */
const loopNode: FlowNode = {
  type: 'loop',
  label: '循环',
  group: 'control',
  sideEffect: false,
  config: {
    times: { type: 'number', label: '跑几轮', hint: '和「跑到什么时候」二选一' },
    until: { type: 'json', label: '跑到什么时候', hint: '每轮结束后判断的条件数组，成立就停' },
  },
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const body = spec.body?.nodes ?? []
    if (body.length === 0) {
      return { ok: false, detail: '这个循环没有循环体', failure: 'config' }
    }
    const runBody = context.runSubflow
    if (runBody === undefined) {
      return { ok: false, detail: '执行器没有提供子图能力，循环跑不了', failure: 'config' }
    }

    const configured = typeof spec.config?.['times'] === 'number' ? spec.config['times'] : undefined
    const until = Array.isArray(spec.config?.['until'])
      ? spec.config['until'] as readonly { readonly kind: string }[]
      : undefined
    if (until === undefined && configured === undefined) {
      return { ok: false, detail: '循环要么写 times（跑几轮），要么写 until（跑到什么时候）', failure: 'config' }
    }
    const wants = configured === undefined ? MAX_ITERATIONS : Math.min(MAX_ITERATIONS, Math.max(1, Math.floor(configured)))

    let rounds = 0
    for (let index = 0; index < wants; index += 1) {
      const outcome = await runBody(body, context)
      rounds += 1
      if (!outcome.ok) {
        return { ok: false, detail: `第 ${String(rounds)} 轮失败：${outcome.detail}`, failure: outcome.failure ?? 'transient' }
      }
      if (until !== undefined && await evaluate(context, until)) {
        return { ok: true, detail: `跑了 ${String(rounds)} 轮后条件成立` }
      }
    }
    if (until !== undefined && configured === undefined) {
      // 靠条件停的循环跑满上限还没停：这是配置写错了，不是「正常结束」。
      return {
        ok: false,
        detail: `跑到上限 ${String(MAX_ITERATIONS)} 轮条件仍未成立`,
        failure: 'config',
      }
    }
    return { ok: true, detail: `跑了 ${String(rounds)} 轮` }
  },
}

/**
 * 内置控制流节点。
 * @returns 可以注册进 `FlowNodeRegistry` 的节点。
 */
export function createControlNodes(): readonly FlowNode[] {
  return [
    // 入口只是落点：事件进不进来由触发器决定，图上它不做任何事。
    passThrough('trigger', '触发', 'trigger'),
    switchNode,
    ifNode,
    loopNode,
    passThrough('parallel', '并行'),
    passThrough('join', '汇合'),
    passThrough('end', '结束'),
  ]
}
