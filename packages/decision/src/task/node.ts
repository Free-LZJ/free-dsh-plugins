/**
 * 节点契约：工作台核心对连接器暴露的唯一形状。
 *
 * 一件事只有一种做法——**读一份声明，在一个上下文里跑一次**。触发、分类、规则、
 * 动作都是它的实现；差别只在 `TSpec`（声明长什么样）与 `TOutcome`（回答里多什么）。
 * 这样「事件和动作都实现同一个接口」不是口号，而是类型上真的同一个类型。
 *
 * 核心不实现任何节点：它只提供这个接口、一张注册表、以及下面这个 {@link defineAction}
 * 模板。模板存在的理由是那五条分支（关掉/试运行/建议/延迟/执行）对每个动作都一样，
 * 写五遍就是五个会各自漂移的真相。
 *
 * @module @free-lzj/dsh-decision/task/node
 */

/** 一次失败的性质——它决定人**还能做什么**（去改配置 / 再试一次 / 只能放弃）。 */
export type FailureKind = 'config' | 'transient' | 'fatal'

/**
 * 一个节点跑完的回答。
 *
 * `status` 是链的走向：`continue` 继续下一个节点，`stop` 正常结束这条链，
 * `halt` 失败终止（后面的节点不再执行）。失败但可以继续的（例如一个动作没成）
 * 用 `ok:false` + `continue`——这是现有行为，也是"一次失败不该吞掉后面的动作"。
 */
export interface NodeOutcome {
  readonly status: 'continue' | 'stop' | 'halt'
  readonly ok: boolean
  /** 给人看的一行说明，失败时含原因。 */
  readonly detail: string
  readonly failure?: FailureKind
  /** 回滚闭包；动作真的改了外部世界时登记。 */
  readonly undo?: () => Promise<void>
  /** 动作建出的会话；链上据此追加一个 `session` 节点。 */
  readonly sessionId?: string
  /** 结构化证据（会话模式、模型名、答案摘要…），写进节点记录的 `data`。 */
  readonly data?: Readonly<Record<string, unknown>>
}

/** 一种节点。 */
export interface TaskNode<TSpec, TContext, TOutcome extends NodeOutcome = NodeOutcome> {
  /** 稳定 kind；同一部署内全局唯一（跨连接器重名会被注册表拒绝）。 */
  readonly kind: string
  /** 这个节点会不会改外部世界；撤销窗口与「建议」据此判定。 */
  readonly sideEffect?: boolean
  /**
   * 跑一次。
   * @param spec - 声明（规则文件里的那一段，或事件本身）。
   * @param context - 这次任务能提供的一切。
   * @returns 结果；**不要抛**——能力缺失与宿主拒绝都折成失败结果加一句说明。
   */
  run(spec: TSpec, context: TContext): Promise<TOutcome>
}

/** 动作节点：声明是一段规则配置，回答是 {@link NodeOutcome}。 */
export type ActionNode<TSpec, TContext> = TaskNode<TSpec, TContext, NodeOutcome>

/**
 * 动作实现的答案：比 {@link NodeOutcome} 少掉链的走向。
 *
 * 动作不决定链怎么走（核心按五分支决定），所以它只回答「成没成、做了什么、要不要
 * 回滚」。`status` 只在必须提前结束时才给（例如动作自己发现前置条件不成立）。
 */
export type ActionOutcome =
  | {
      readonly ok: true
      readonly detail: string
      readonly sessionId?: string
      readonly undo?: () => Promise<void>
      readonly status?: 'continue' | 'stop'
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly ok: false
      readonly message: string
      readonly sessionId?: string
      readonly failure?: FailureKind
      readonly status?: 'continue' | 'halt'
      readonly data?: Readonly<Record<string, unknown>>
    }

/** 写一个动作节点时要填的东西。 */
export interface ActionDefinition<TSpec, TContext> {
  readonly kind: string
  /** 改了外部世界没有；`true` 才进撤销窗口与建议三态。 */
  readonly sideEffect: boolean
  run(spec: TSpec, context: TContext): Promise<ActionOutcome>
}

/**
 * 把一个动作实现包成节点。
 *
 * 五条分支（关掉/试运行/建议/延迟/执行）由编排层处理，所以这里只做一件事：把
 * {@link ActionOutcome} 折成 {@link NodeOutcome}。连接器因此永远不用重复写
 * 「失败了该不该继续」「撤销要登记给谁」。
 * @param definition - 连接器写的那个实现。
 * @returns 可以直接注册的动作节点。
 */
export function defineAction<TSpec, TContext>(
  definition: ActionDefinition<TSpec, TContext>,
): ActionNode<TSpec, TContext> {
  return {
    kind: definition.kind,
    sideEffect: definition.sideEffect,
    async run(spec, context) {
      const outcome = await definition.run(spec, context)
      if (outcome.ok) {
        return {
          status: outcome.status ?? 'continue',
          ok: true,
          detail: outcome.detail,
          ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
          ...(outcome.undo === undefined ? {} : { undo: outcome.undo }),
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
        }
      }
      return {
        // 失败默认继续：一个动作没成不该吞掉后面排队的动作（记录会标 partial）。
        status: outcome.status ?? 'continue',
        ok: false,
        detail: outcome.message,
        failure: outcome.failure ?? 'transient',
        ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
      }
    },
  }
}
