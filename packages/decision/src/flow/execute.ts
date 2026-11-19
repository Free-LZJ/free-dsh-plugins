/**
 * 图执行器：按节点依赖跑一张流程，支持扇出、汇合、挂起与续跑。
 *
 * 三条规则决定了它的全部行为：
 *
 * 1. **就绪判据是「所有入边都满足」**，不是「上一个节点结束了」。所以汇合不需要特殊
 *    节点——`join` 只是一个落点，入边齐了它才进队列。
 * 2. **同批并发**。一次取完整个就绪队列用 `Promise.all` 跑，于是 `mode: 'fork'` 扇出的
 *    分支真正同时执行；顺序分支只有一条，等价串行。
 * 3. **每步落盘**。进度随跑随存，崩溃或重启后不必重跑副作用动作——这与「动作参数排队
 *    时固化」是同一思路。
 *
 * 执行器不认识任何节点：它只按 `type` 从注册表取实现，按 `next` 决定走哪些出边。
 *
 * @module @free-lzj/dsh-decision/flow/execute
 */

import type { FlowNodeRegistry } from './registry.ts'
import type { Task } from '../task/record.ts'
import type {
  ConditionEvaluator, FailureKind, Flow, FlowContext, FlowNodeSpec, FlowProgress, FlowResult, NodeRecordInput, NodeResult,
  PendingWait,
} from './types.ts'

/** 一轮执行需要的端口。 */
export interface FlowDeps {
  /** 已注册的节点类型。 */
  readonly registry: FlowNodeRegistry
  /** 记一格。按发生顺序调用；返回 Promise 时执行器会等它落盘。 */
  readonly record: (entry: NodeRecordInput) => Promise<void> | void
  readonly log: (line: string) => void
  /** 进度落盘；省略表示这一轮不持久化（测试与干跑）。 */
  readonly saveProgress?: (progress: FlowProgress) => Promise<void> | void
  /**
   * 干跑：走完整张图，但**有副作用的节点只记录不执行**。
   *
   * 放在执行器而不是节点里：节点不该为了试跑去写第二套实现，而「有没有副作用」节点
   * 自己已经声明了。
   */
  readonly dryRun?: boolean
}

/** 一轮执行的输入。 */
export interface ExecuteOptions {
  readonly taskId: string
  readonly runId: string
  /** 事件投影；不含正文。 */
  readonly event: Readonly<Record<string, string>>
  /** 续跑时给回上次的进度与变量。 */
  readonly progress?: FlowProgress
  readonly vars?: Readonly<Record<string, unknown>>
  readonly facts?: { label?: string; confidence?: number }
  /** 唤醒挂起节点的载荷。 */
  readonly signal?: Readonly<Record<string, unknown>>
  /** 任务全量视图；动作节点靠它取标题与模板变量。 */
  readonly task?: Task
  /** 连接器端口。 */
  readonly ports?: Readonly<Record<string, unknown>>
  /** 条件求值器；控制流节点用它。 */
  readonly evaluate?: ConditionEvaluator
  /** 跑一个旧式动作；动作节点用它保留撤销与延迟。 */
  readonly executeAction?: FlowContext['executeAction']
  /** 跑一个命名的工作流；由 engine 提供，因为只有它认得全部工作流文件。 */
  readonly runWorkflow?: FlowContext['runWorkflow']
  /** 同一轮最多挂起几次；挡住「挂起-恢复-挂起」的死循环。 */
  readonly maxSuspends?: number
}

/** 单轮挂起上限。 */
const DEFAULT_MAX_SUSPENDS = 50

/** 边的键。 */
function edgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

/**
 * 跑一轮。
 * @param flow - 要跑的图。
 * @param options - 事件、续跑状态与信号。
 * @param deps - 注册表、记录与落盘。
 * @returns 结论与跑完（或停住）的进度。
 */
export async function executeFlow(
  flow: Flow,
  options: ExecuteOptions,
  deps: FlowDeps,
): Promise<FlowResult> {
  const byId = new Map<string, FlowNodeSpec>()
  for (const node of flow.nodes) byId.set(node.id, node)

  /** 每个节点的入边来源，用来判「齐了没有」。 */
  const inbound = new Map<string, string[]>()
  for (const node of flow.nodes) inbound.set(node.id, [])
  for (const node of flow.nodes) {
    for (const edge of node.out ?? []) {
      inbound.get(edge.to)?.push(node.id)
    }
  }

  const state: {
    done: string[]
    satisfied: string[]
    ready: string[]
    suspendedAt?: string
    pending?: PendingWait
    suspends: number
  } = {
    done: [...(options.progress?.done ?? [])],
    satisfied: [...(options.progress?.satisfied ?? [])],
    ready: [...(options.progress?.ready ?? [])],
    ...(options.progress?.suspendedAt === undefined ? {} : { suspendedAt: options.progress.suspendedAt }),
    ...(options.progress?.pending === undefined ? {} : { pending: options.progress.pending }),
    suspends: options.progress?.suspends ?? 0,
  }
  if (options.progress === undefined) {
    // 首次执行：入度为 0 的节点是入口（通常是 trigger 与它后面的分支点）。
    state.ready = flow.nodes.filter(node => (inbound.get(node.id) ?? []).length === 0).map(node => node.id)
  }

  const context: FlowContext = {
    event: options.event,
    vars: { ...(options.vars ?? {}) },
    memory: {},
    facts: { ...(options.facts ?? {}) },
    taskId: options.taskId,
    flowId: flow.id,
    runId: options.runId,
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.evaluate === undefined ? {} : { evaluate: options.evaluate }),
    ...(options.executeAction === undefined ? {} : { executeAction: options.executeAction }),
    // 每一格都盖上「哪张图」：一次执行会跨图（事件流调子工作流），只有 nodeId 时
    // `trigger` / `route` / `end` 这类到处都有的 id 分不清归属。
    record: entry => { return deps.record({ ...entry, flowId: flow.id }) },
    log: line => { deps.log(line) },
    // 子图借用同一个执行器跑：复合节点（`loop`）不该自己实现一遍调度。
    // 进度独立——子图跑完一轮，主图还是停在那个 loop 节点上。
    runSubflow: async (nodes, outer) => {
      const inner: Flow = {
        id: `${flow.id}/${'body'}`,
        name: `${flow.name} 的循环体`,
        connector: flow.connector,
        nodes,
      }
      const result = await executeFlow(inner, {
        taskId: options.taskId,
        runId: options.runId,
        event: outer.event,
        vars: outer.vars,
        facts: outer.facts,
        ...(options.task === undefined ? {} : { task: options.task }),
        ...(options.ports === undefined ? {} : { ports: options.ports }),
        ...(options.evaluate === undefined ? {} : { evaluate: options.evaluate }),
      }, deps)
      return result.status === 'done'
        ? { ok: true, detail: result.matched ?? 'done' }
        // 子图的 failed 只来自 config / fatal / 执行器自身出错，都该原样上报。
        : { ok: false, detail: result.error ?? result.matched ?? result.status, ...(result.status === 'failed' ? { failure: 'config' as const } : {}) }
    },
    // 命名的子工作流由外面找图（它可能在别的文件里），执行器只负责把上下文带过去。
    ...(options.runWorkflow === undefined ? {} : { runWorkflow: options.runWorkflow }),
  }

  let failure: FailureKind | undefined
  let error: string | undefined
  let matched: string | undefined

  const persist = async (): Promise<void> => {
    await deps.saveProgress?.(snapshot())
  }
  const snapshot = (): FlowProgress => ({
    done: [...state.done],
    satisfied: [...state.satisfied],
    ready: [...state.ready],
    ...(state.suspendedAt === undefined ? {} : { suspendedAt: state.suspendedAt }),
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    suspends: state.suspends,
  })

  /**
   * 把一条边标成满足；目标节点够不够格进就绪队列，看它是什么节点。
   *
   * **只有 `join` 等全部入边**；其余节点是「任一入边到就走」。这条区分是必须的：
   * 两条分支汇到同一个末节点时，若也要求全齐，只有一条走过就永远等不到另一条，
   * 流程会静静停住。
   */
  const takeEdge = (from: string, to: string): void => {
    const key = edgeKey(from, to)
    if (!state.satisfied.includes(key)) state.satisfied.push(key)
    if (state.done.includes(to) || state.ready.includes(to)) return
    const sources = inbound.get(to) ?? []
    const all = byId.get(to)?.type === 'join'
    const armed = all
      ? sources.every(source => state.satisfied.includes(edgeKey(source, to)))
      : sources.some(source => state.satisfied.includes(edgeKey(source, to)))
    if (armed) state.ready.push(to)
  }

  while (state.ready.length > 0) {
    const batch = [...state.ready]
    state.ready = []

    const outcomes = await Promise.all(batch.map(async (id) => {
      const spec = byId.get(id)
      if (spec === undefined) {
        return { id, kind: 'missing' as const, spec: undefined, result: undefined }
      }
      if (spec.enabled === false) {
        return { id, kind: 'disabled' as const, spec, result: undefined }
      }
      const node = deps.registry.get(spec.type)
      if (node === undefined) {
        await context.record({
          nodeId: id,
          type: spec.type,
          ok: false,
          detail: `节点类型「${spec.type}」没有注册`,
          failure: 'config',
        })
        return { id, kind: 'unknown' as const, spec, result: undefined }
      }
      if (deps.dryRun === true && node.sideEffect === true) {
        return { id, kind: 'dry' as const, spec, result: undefined, node }
      }
      let result: NodeResult
      try {
        result = await node.run(spec, context)
      } catch (thrown: unknown) {
        result = {
          ok: false,
          detail: `节点抛错：${thrown instanceof Error ? thrown.message : String(thrown)}`,
          failure: 'transient',
        }
      }
      return { id, kind: 'ran' as const, spec, result, node }
    }))

    for (const outcome of outcomes) {
      const { id, spec, result } = outcome

      if (outcome.kind === 'missing') {
        failure = 'config'
        error = `流程里有节点 ${id} 不在图里`
        continue
      }
      // 禁用节点：直接放行到它的出边，等于「跳过这一步」。
      if (outcome.kind === 'disabled') {
        await context.record({ nodeId: id, type: spec?.type ?? '?', ok: true, detail: '已禁用，跳过' })
        state.done.push(id)
        for (const edge of spec?.out ?? []) takeEdge(id, edge.to)
        continue
      }
      if (outcome.kind === 'unknown') {
        failure = 'config'
        state.done.push(id)
        continue
      }
      // 干跑：记一格「没有执行」，然后照常往下走，让人看到完整路径。
      if (outcome.kind === 'dry') {
        await context.record({
          nodeId: id,
          type: spec?.type ?? '?',
          ok: true,
          detail: '试运行：只记录，未执行',
        })
        state.done.push(id)
        for (const edge of spec?.out ?? []) takeEdge(id, edge.to)
        continue
      }

      const ran = result as NodeResult

      // 挂起：不再往下走，把进度存下来就返回。
      if ('suspend' in ran && ran.suspend !== undefined) {
        state.suspends += 1
        if (state.suspends > (options.maxSuspends ?? DEFAULT_MAX_SUSPENDS)) {
          await context.record({
            nodeId: id,
            type: spec?.type ?? '?',
            ok: false,
            detail: `同一轮挂起超过 ${String(options.maxSuspends ?? DEFAULT_MAX_SUSPENDS)} 次，判为死循环`,
            failure: 'fatal',
          })
          failure = 'fatal'
          state.done.push(id)
          continue
        }
        state.suspendedAt = id
        // 令牌必须落盘：恢复入口只能靠它认出「在等哪一次」。节点没给就按任务 + 节点
        // + 第几次挂起造一个——同一条链上挂起多次时，前一次的令牌不会唤错后一次。
        const token = ran.suspend.token ?? `${options.taskId}:${id}:${String(state.suspends)}`
        state.pending = {
          nodeId: id,
          on: ran.suspend.on,
          token,
          ...(ran.suspend.dueAt === undefined ? {} : { dueAt: ran.suspend.dueAt }),
          ...(ran.suspend.resume === undefined ? {} : { resume: ran.suspend.resume }),
          detail: ran.suspend.detail,
          ...(ran.suspend.nested === undefined ? {} : { nested: ran.suspend.nested }),
        }
        // 把节点放回就绪队列：恢复时直接重跑它，而它的入边仍然满足。
        state.ready = [id]
        await context.record({
          nodeId: id,
          type: spec?.type ?? '?',
          ok: true,
          detail: ran.suspend.detail,
          data: {
            suspendOn: ran.suspend.on,
            token,
            ...(ran.suspend.dueAt === undefined ? {} : { dueAt: ran.suspend.dueAt }),
          },
        })
        await persist()
        return {
          status: 'suspended',
          progress: snapshot(),
          ...(matched === undefined ? {} : { matched }),
        }
      }

      // 走到这里的都是「有 detail」的分支——挂起那种已经在上面 return 了。
      // 用 detail 作为判据而不是 `as`：挂起分支没有 detail，类型上就排除了它。
      const plain = ran as Extract<NodeResult, { detail: string }>
      const ok = plain.ok
      const kind = ok ? undefined : (plain.failure ?? 'transient')

      // 产出分派：节点声明了 outputs 就按声明走，否则一律进 vars（保守选择：
      // 猜错成 memory 会让数据在重放时凭空消失）。
      if (ok && plain.output !== undefined) {
        const declared = outcome.node?.outputs
        for (const [key, value] of Object.entries(plain.output)) {
          const specOfKey = declared?.find(output => output.key === key)
          if (specOfKey?.persist === false) context.memory[key] = value
          else context.vars[key] = value
          if (key === 'label' && typeof value === 'string') context.facts.label = value
          if (key === 'confidence' && typeof value === 'number') context.facts.confidence = value
        }
      }

      await context.record({
        nodeId: id,
        type: spec?.type ?? '?',
        ok,
        detail: plain.detail,
        ...(kind === undefined ? {} : { failure: kind }),
        ...(plain.sessionId === undefined ? {} : { sessionId: plain.sessionId }),
      })
      // 挂起的节点跑完了：它已经等到东西，标记与令牌一起清掉，别让下一次挂起继承旧的。
      if (state.suspendedAt === id) {
        delete state.suspendedAt
        delete state.pending
      }
      state.done.push(id)

      if (spec?.type === 'switch' || spec?.type === 'if') matched ??= `${id}: ${plain.detail}`

      if (!ok && (kind === 'config' || kind === 'fatal')) {
        failure = kind
        // 配置错与致命错中止这一轮：继续跑只会污染更多下游。
        continue
      }
      if (!ok) failure = failure ?? kind ?? 'transient'

      // 走哪些出边：节点说了算，没说就全走（失败也走，一个动作没成不该吞掉后面的）。
      const chosen = plain.next
      for (const edge of spec?.out ?? []) {
        if (chosen !== undefined && !chosen.includes(edge.to)) continue
        takeEdge(id, edge.to)
      }
    }

    await persist()
    if (failure === 'config' || failure === 'fatal') break
  }

  const status: FlowResult['status'] = error !== undefined || failure === 'config' || failure === 'fatal'
    ? 'failed'
    : state.done.length === 0
      ? 'skipped'
      : failure === undefined ? 'done' : 'partial'

  return {
    status,
    progress: snapshot(),
    ...(matched === undefined ? {} : { matched }),
    ...(error === undefined ? {} : { error }),
  }
}
