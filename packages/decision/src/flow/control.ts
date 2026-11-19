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
 * `workflow`：跳到另一个工作流文件去执行。
 *
 * 与 `loop` 的 `body` 不同，它引用的是**另一份文件**（`workflows/<id>.yml`），于是同一
 * 段"处理 GitHub 工单"的步骤能被多个事件流复用，改一次两处都变。
 *
 * **变量是显式传的**：`pass` 没写就传全部（event / vars / memory），写了就只传列出的。
 * 下游看不到未列出的东西——工作流之间不该长出看不见的依赖。
 */
const workflowNode: FlowNode = {
  type: 'workflow',
  label: '工作流',
  group: 'control',
  // 工作流里通常有真动作，保守地当作有副作用。
  sideEffect: true,
  config: {
    workflow: { type: 'text', label: '哪个工作流', hint: 'workflows/ 目录里的 id' },
    pass: { type: 'json', label: '传哪些变量', hint: '不填就全传；填了只传列出的那些' },
  },
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const id = typeof spec.config?.['workflow'] === 'string' ? spec.config['workflow'].trim() : ''
    if (id === '') return { ok: false, detail: '这个节点没说要跑哪个工作流', failure: 'config' }

    const run = context.runWorkflow
    if (run === undefined) {
      return { ok: false, detail: '执行器没有提供工作流能力', failure: 'config' }
    }

    const pass = Array.isArray(spec.config?.['pass'])
      ? (spec.config['pass'] as unknown[]).filter((key): key is string => typeof key === 'string')
      : undefined
    const vars = passWorkflowVars(context, pass)

    const outcome = await run(id, vars, context)
    if (outcome.ok) {
      // 子工作流自己挂起了：把「在等什么」连同它停在哪一格一起交上去，父图照原样停住。
      if (outcome.wait !== undefined) return { ok: true, suspend: outcome.wait }
      return { ok: true, detail: `工作流 ${id}：${outcome.detail}` }
    }
    return {
      ok: false,
      detail: `工作流 ${id}：${outcome.detail}`,
      // 子工作流是 config/fatal 时不能降级成 transient——重试只会再错一次。
      failure: outcome.failure ?? 'transient',
    }
  },
}

/**
 * 挑出要传给子工作流的变量。
 * @param context - 调用方上下文。
 * @param pass - 要传的键；undefined 表示全传。
 * @returns 一份新的、可以安全交给下游的变量表。
 */
function passWorkflowVars(
  context: FlowContext,
  pass: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  /** memory 排在最后：同名的键以它为准，因为正文这类数据只有它有。 */
  const all: Record<string, unknown> = { ...context.event, ...context.vars, ...context.memory }
  if (pass === undefined) return all
  const picked: Record<string, unknown> = {}
  for (const key of pass) {
    if (all[key] !== undefined) picked[key] = all[key]
  }
  return picked

}

/**
 * 把 `params` / `outputs` 这类声明收成一份字符串清单。
 *
 * 两种写法都认：`['subject', 'body']` 或者 `[{ name: 'subject', required: true }]`。
 * 手写 yml 时前者省事，界面上生成的后者带必填信息。
 * @param value - 配置里的原始值。
 * @returns 名字与必填标记。
 */
function declaredNames(value: unknown): readonly { readonly name: string; readonly required: boolean }[] {
  if (!Array.isArray(value)) return []
  const out: { name: string; required: boolean }[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push({ name: item.trim(), required: false })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const name = (item as { readonly name?: unknown }).name
    if (typeof name !== 'string' || name.trim() === '') continue
    out.push({ name: name.trim(), required: (item as { readonly required?: unknown }).required === true })
  }
  return out
}

/**
 * `start`：子工作流的**入口**，声明它要什么参数。
 *
 * 声明过就是契约：必填的没收到，这一步**明确失败**（`failure: 'config'`），原因里列出
 * 缺了哪些——而不是让它带着空值往下跑，最后在某一步莫名其妙地出错。没有声明就什么都不
 * 做，老图照样能跑。
 */
const startNode: FlowNode = {
  type: 'start',
  label: '开始',
  group: 'control',
  sideEffect: false,
  config: {
    params: { type: 'names', label: '入参', hint: '调用方按名字传；勾了必填的收不到就判这一步失败' },
  },
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const declared = declaredNames(spec.config?.['params'])
    if (declared.length === 0) return { ok: true, detail: '开始' }
    const missing = declared
      .filter(item => item.required)
      .filter(item => {
        const value = context.vars[item.name] ?? context.event[item.name]
        return value === undefined || value === null || value === ''
      })
      .map(item => item.name)
    if (missing.length > 0) {
      return { ok: false, detail: `缺少入参：${missing.join(', ')}`, failure: 'config' }
    }
    const provided = declared.filter(item => (context.vars[item.name] ?? context.event[item.name]) !== undefined)
    return { ok: true, detail: `开始（收到 ${String(provided.length)}/${String(declared.length)} 个入参）` }
  },
}

/**
 * `end`：一段流程的**出口**，可声明它交出什么。
 *
 * 出参缺失只**如实说**，不判失败：一段流程经常在早期分支就结束，那时后面的变量本来就
 * 还没有。这一格记下来，看板上就能回答「这条规则为什么没给我要的东西」。
 */
const endNode: FlowNode = {
  type: 'end',
  label: '结束',
  group: 'control',
  sideEffect: false,
  config: {
    outputs: { type: 'names', label: '出参', hint: '这一步结束时应该带着哪些变量' },
  },
  async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
    const declared = declaredNames(spec.config?.['outputs'])
    if (declared.length === 0) return { ok: true, detail: '结束' }
    const absent = declared
      .map(item => item.name)
      .filter(name => {
        const value = context.vars[name] ?? context.memory[name]
        return value === undefined || value === null || value === ''
      })
    return absent.length === 0
      ? { ok: true, detail: `结束（交出 ${String(declared.length)} 个出参）` }
      : { ok: true, detail: `结束（没有出参：${absent.join(', ')}）` }
  },
}

/**
 * 把控制流节点装成一份清单。
 * @returns 可以注册进 `FlowNodeRegistry` 的节点。
 */
export function createControlNodes(): readonly FlowNode[] {
  return [
    // 入口只是落点：事件进不进来由触发器决定，图上它不做任何事。
    passThrough('trigger', '触发', 'trigger'),
    // 子工作流的入口：声明入参，缺必填就明确失败。
    startNode,
    switchNode,
    ifNode,
    loopNode,
    workflowNode,
    passThrough('parallel', '并行'),
    passThrough('join', '汇合'),
    // 出口：可以声明出参，缺了如实说。
    endNode,
  ]
}
