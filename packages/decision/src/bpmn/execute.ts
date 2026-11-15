/**
 * 用 bpmn-engine 跑一棵编译好的流程，并把每一步变成一条节点记录。
 *
 * **判定先算，动作后跑。** 所有规则的命中布尔值在开跑之前就算完并写进流程变量，
 * 流程本身只做「按网关字符串行」和「执行动作」。这条分界线是被引擎逼出来的：
 * bpmn-engine 在入边被 take 的瞬间求值网关条件，而 take 发生在源活动开始而不是结束，
 * 所以异步判定节点后面接网关会读到还没写的变量（见 `compile.ts` 的注释）。
 * 判定挪到外面之后，流程里只剩同步路由，语义与原来「先分类、再首命中」一致。
 *
 * 这里是「图就是定义」的落点：执行器不认识规则、条件和动作，遇到 serviceTask 就回头
 * 问调用方「这一步该做什么」。连接器注册的条件与动作不需要迁移，只是换一种被调用方式。
 *
 * @module @free-lzj/dsh-decision/bpmn/execute
 */

import { Engine } from 'bpmn-engine'
import { hitVariable, type CompiledFlow } from './compile.ts'

/** 一个动作跑完的答案；与内核的 `ActionOutcome` 同形，少掉链的走向。 */
export interface FlowActionOutcome {
  readonly ok: boolean
  /** 给人看的一行，失败时含原因。 */
  readonly detail: string
  readonly sessionId?: string
  readonly failure?: 'config' | 'transient' | 'fatal'
  readonly undo?: () => Promise<void>
}

/** 流程走过一格时记下的一件事。 */
export interface FlowNodeRecord {
  readonly nodeId: string
  /** `rule`（一条规则被判定命中）或动作自己的 kind。 */
  readonly kind: string
  readonly ok: boolean
  readonly detail: string
  readonly ruleId?: string
  readonly actionIndex?: number
  readonly sessionId?: string
  readonly failure?: 'config' | 'transient' | 'fatal'
}

/** 跑一次流程需要调用方提供的东西。 */
export interface BpmnFlowDeps {
  /** 这条规则的条件是否全部成立；会在开跑前对每条规则各问一次。 */
  readonly judge: (ruleId: string) => Promise<boolean>
  /** 执行一条规则里的第几个动作。 */
  readonly runAction: (ruleId: string, index: number) => Promise<FlowActionOutcome>
  /** 记下一格。按发生顺序调用。 */
  readonly record: (node: FlowNodeRecord) => Promise<void> | void
  /** 等流程结束的上限；默认 30 秒。 */
  readonly timeoutMs?: number
}

/** 一次运行的结论。 */
export interface FlowSummary {
  /** 命中的第一条规则；一条都没中时 undefined。 */
  readonly matchedRuleId?: string
  readonly status: 'done' | 'partial' | 'skipped' | 'failed'
  readonly actions: readonly FlowActionOutcome[]
  /** 执行器自己出错时的说明（流程本身是好的）。 */
  readonly error?: string
}

/** bpmn-engine 交给 service 函数的作用域，只取这里用到的两样。 */
interface ServiceScope {
  readonly id: string
  readonly environment: { variables: Record<string, unknown> }
}

/** 让出一次事件循环。 */
function tick(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * 跑一棵编译好的流程。
 * @param flow - 编译产物。
 * @param deps - 判定、动作与记录。
 * @returns 结论。
 */
export async function runFlow(flow: CompiledFlow, deps: BpmnFlowDeps): Promise<FlowSummary> {
  const actions: FlowActionOutcome[] = []
  let failed = false
  let engineError: string | undefined

  // 1) 判定：按顺序问；命中一条 `stopOnMatch` 为真的规则就停——后面的网关根本不会被访问
  // （命中那条直接走到自己的 end），所以它们的标志位留空是安全的，也免得为不会用到的规则
  // 读正文、调模型。`stopOnMatch: false` 的规则命中后仍要往下问，因为它的 then 要追加。
  const variables: Record<string, unknown> = {}
  let matchedRuleId: string | undefined
  for (const [index, ruleId] of flow.order.entries()) {
    const hit = await deps.judge(ruleId)
    variables[hitVariable(index)] = hit
    if (!hit) continue
    if (matchedRuleId === undefined) matchedRuleId = ruleId
    // 命中一条记一条：`stopOnMatch: false` 时可能连着命中好几条，它们都要在链上留下痕迹。
    await deps.record({
      nodeId: `gw_${hitVariable(index)}`,
      kind: 'rule',
      ok: true,
      detail: flow.labels.get(ruleId) ?? ruleId,
      ruleId,
    })
    if (!flow.continues.includes(index)) break
  }

  // 2) 执行：流程里只剩下网关与动作。
  const services = {
    step(scope: ServiceScope, next: (error: Error | null, output?: unknown) => void): void {
      void (async () => {
        const planned = flow.steps.get(scope.id)
        if (planned === undefined) throw new Error(`流程里有一步没有编入计划：${scope.id}`)
        const outcome = await deps.runAction(planned.ruleId, planned.index)
        actions.push(outcome)
        if (!outcome.ok) failed = true
        // `record` 允许同步实现，所以不能直接对它调 `.then`。
        await deps.record({
          nodeId: scope.id,
          kind: 'action',
          ok: outcome.ok,
          detail: outcome.detail,
          ruleId: planned.ruleId,
          actionIndex: planned.index,
          ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
          ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
        })
        next(null, { ok: outcome.ok })
      })().catch((error: unknown) => {
        next(error instanceof Error ? error : new Error(String(error)))
      })
    },
  }

  try {
    const engine = new Engine({ name: 'dsh-decision', source: flow.xml, variables })
    engine.on('error', (error: unknown) => {
      engineError = error instanceof Error ? error.message : String(error)
    })
    // `state` 不能用来等结束：`execute()` 返回时执行器可能还没开跑，那一刻同样是 idle。
    // 只有引擎自己发的 `end` 才能证明整条链走完了。
    let ended = false
    engine.on('end', () => { ended = true })
    await engine.execute({ services })
    const deadline = Date.now() + (deps.timeoutMs ?? 30_000)
    while (!ended && engineError === undefined && Date.now() < deadline) await tick()
    if (engineError === undefined && !ended) {
      engineError = `流程没有在 ${String(deps.timeoutMs ?? 30_000)}ms 内结束`
      engine.stop()
    }
  } catch (error: unknown) {
    engineError = error instanceof Error ? error.message : String(error)
  }

  const status: FlowSummary['status'] = engineError !== undefined
    ? 'failed'
    : matchedRuleId === undefined
      ? 'skipped'
      : failed ? 'partial' : 'done'

  return {
    ...(matchedRuleId === undefined ? {} : { matchedRuleId }),
    status,
    actions,
    ...(engineError === undefined ? {} : { error: engineError }),
  }
}
