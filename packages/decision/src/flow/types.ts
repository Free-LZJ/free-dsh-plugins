/**
 * 节点图的形状：一张流程、一个节点、一条出边，以及运行时共享的上下文。
 *
 * 与 `types.ts` 的 `Rule` 是两代模型：规则是「列表 + then 数组」，控制流藏在
 * `priority` 排序里；这里是**显式的图**——节点有 id、有出边、可以扇出与汇合，动作
 * 与条件都是节点。两者的分界见 `docs/rules-orchestration-analysis.md`。
 *
 * 这个模块只有类型：解析、执行、布局各自在自己的文件里。
 *
 * @module @free-lzj/dsh-decision/flow/types
 */

import type { ConditionSpecLike } from '../registry.ts'
import type { FailureKind } from '../task/node.ts'
import type { Task } from '../task/record.ts'

export type { FailureKind }

/* ─────────────────────────────── 图的形状 ─────────────────────────────── */

/** 一张流程图。一个 rules.yml 可以有多张（`flows: []`）。 */
export interface Flow {
  readonly id: string
  readonly name: string
  /** 归属连接器；决定条件与动作的词表。`'*'` 表示收所有连接器的事件。 */
  readonly connector: string
  readonly nodes: readonly FlowNodeSpec[]
}

/** 图上的一个节点。 */
export interface FlowNodeSpec {
  readonly id: string
  /** 节点类型：内置控制流 kind，或连接器注册的动作 kind。 */
  readonly type: string
  /** 节点配置；字段由节点类型的 `config` schema 声明。 */
  readonly config?: Readonly<Record<string, unknown>>
  /** 出边。缺省 = 终止节点。 */
  readonly out?: readonly FlowEdgeSpec[]
  /**
   * 实现选择器。
   *
   * 同一个 `type` 可以有多套实现（`session` 能开真会话，也能只调一次模型），选哪个
   * 由这里说。缺省取节点类型声明的第一个 runner。
   */
  readonly runner?: string
  /**
   * 渲染坐标。**人拖拽过才有，agent 不写**。
   *
   * 它是渲染信息而不是结构：缺了就由 `layout.ts` 补位，不会因为新增一个节点把整张
   * 图重排。
   */
  readonly pos?: { readonly x: number; readonly y: number }
  /** 关掉这个节点：执行时跳过，图上显示为灰。缺省为启用。 */
  readonly enabled?: boolean
  /** 图上显示的名字；缺省用节点类型的 label。 */
  readonly label?: string
  /**
   * 复合节点自己的子图（目前只有 loop 用）。
   *
   * 内联而不是引用另一张图：循环体通常只有两三个节点，拆成独立流程会让人在两个页面
   * 之间来回看。子图**不参与主图的边**，只由承载它的节点执行。
   */
  readonly body?: { readonly nodes: readonly FlowNodeSpec[] }
}

/** 一条出边。 */
export interface FlowEdgeSpec {
  /** 目标节点 id。 */
  readonly to: string
  /**
   * 条件。为空即无条件。
   *
   * `switch` 的每个分支都带条件，最后一条不带的是兜底；其余节点只走一条无条件出边。
   */
  readonly when?: readonly ConditionSpecLike[]
  /**
   * 扇出/汇合标记。
   *
   * `fork` 表示这条边与兄弟边**同时**走（并行扇出）；缺省是顺序的单条边。
   * 汇合不需要标记：一个节点的所有入边都满足，它才进就绪队列。
   */
  readonly mode?: 'fork'
}

/* ─────────────────────────────── 节点类型 ─────────────────────────────── */

/** 属性面板的字段类型。 */
export type ConfigFieldType = 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'json'

/** 一个配置字段的声明。 */
export interface ConfigField {
  readonly type: ConfigFieldType
  readonly label?: string
  readonly required?: boolean
  readonly default?: unknown
  /** `enum` 必填。 */
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly placeholder?: string
  /** 一句话说明，面板显示在字段下方。 */
  readonly hint?: string
  /** 该字段支持 `{var}` 占位符；面板据此提示可用变量。 */
  readonly template?: boolean
}

/** 一张节点的配置表。缺省表示这个节点没有可配字段（面板退化为 JSON 编辑）。 */
export type ConfigSchema = Readonly<Record<string, ConfigField>>

/** 一套实现。同一个节点类型可以有多个，用 `spec.runner` 选。 */
export interface RunnerSpec {
  readonly id: string
  readonly label: string
  /** 这套实现额外的配置字段；面板切换 runner 时按它重渲染。 */
  readonly config?: ConfigSchema
}

/** 节点产出的一个变量。 */
export interface OutputSpec {
  readonly key: string
  /**
   * 是否落盘。缺省 true（写进 `vars`）。
   *
   * `false` 表示写进 `memory`：正文、HTML 这类大体积或敏感数据，任务落盘时丢弃，
   * 因此重放与挂起恢复后它为空。见 `docs/rules-orchestration-analysis.md` 的上下文分层。
   */
  readonly persist?: boolean
  readonly label?: string
}

/** 节点的类别。只有三类：动作里有成本的也算动作。 */
export type NodeGroup = 'trigger' | 'control' | 'action'

/* ─────────────────────────────── 执行 ─────────────────────────────── */

/** 求值一组条件；由执行器注入，因为条件词表属于连接器。 */
export type ConditionEvaluator = (
  when: readonly ConditionSpecLike[],
  context: FlowContext,
) => Promise<boolean>

/** 一次执行能读到、能写进去的一切。节点之间**不直接传参**，只通过它交互。 */
export interface FlowContext {
  /** 事件投影，只读，落盘。例：`{ subject, from, repo }`。不含邮件正文。 */
  readonly event: Readonly<Record<string, string>>
  /** 节点产出，落盘。label、sessionId 这类小数据。 */
  readonly vars: Record<string, unknown>
  /** 节点产出，**不落盘**。正文、HTML、附件列表。 */
  readonly memory: Record<string, unknown>
  /** 跨节点事实，落盘。分类结果放这里。 */
  readonly facts: { label?: string; confidence?: number }
  /** 本次执行属于哪个任务与哪张流程。 */
  readonly taskId: string
  readonly flowId: string
  readonly runId: string
  /**
   * 这次执行属于哪个任务的全量视图。
   *
   * 执行期数据，不进快照：动作节点要靠它取标题、模板变量与连接器端口。省略时表示
   * 这一步不需要任务上下文（控制流节点就不需要）。
   */
  readonly task?: Task
  /** 连接器挂上来的端口；动作节点按需取自己那份。 */
  readonly ports?: Readonly<Record<string, unknown>>
  /**
   * 条件求值。控制流节点用它，执行器注入。
   *
   * 核心不认识「邮件的 from 条件长什么样」，所以这个能力必须从外面来；缺省时条件
   * 一律判不成立（不是崩溃——那样一张图只因为没接求值器就跑不了）。
   */
  readonly evaluate?: ConditionEvaluator
  /**
   * 跑一段子图（loop 用）。由执行器注入——复合节点不该自己去实现一遍调度。
   *
   * 子图与主图共享 ars / acts / memory，但进度独立：子图跑完一轮，主图的
   * 进度不受影响。
   */
  /**
   * 跑一个旧式动作（ActionNode）。dapt 造的节点用它，于是撤销、延迟排队、
   * 试运行这些**由 runner 管**的能力在图的路径上也保留。
   *
   * 缺省时 adapter 直接调 ction.run——试运行之类就没了，所以真正跑的路径必须注入。
   */
  readonly executeAction?: (
    kind: string,
    spec: FlowNodeSpec,
    context: FlowContext,
  ) => Promise<{ readonly ok: boolean; readonly detail: string; readonly failure?: FailureKind; readonly sessionId?: string }>
  readonly runSubflow?: (nodes: readonly FlowNodeSpec[], context: FlowContext) => Promise<{
    readonly ok: boolean
    readonly detail: string
    /** 子图为什么失败；config / atal 表示不该重试。 */
    readonly failure?: FailureKind
  }>
  /**
   * 跑一个**命名的工作流**（`workflows/<id>.yml`）。
   *
   * 与 `runSubflow` 的区别：那个跑的是同一张图里内嵌的一段（loop 用），这里跳进另
   * 一份文件。子工作流**只能看到调用方传下去的变量**——读不到主图的全量 `vars`，这是
   * 有意的：否则工作流之间会长出一张看不见的依赖网。传什么由节点的 `config.pass` 定。
   * @param workflowId - 工作流 id。
   * @param vars - 传下去的变量。
   * @param context - 调用方上下文，用来取 task / ports / 执行期能力。
   */
  readonly runWorkflow?: (workflowId: string, vars: Readonly<Record<string, unknown>>, context: FlowContext) => Promise<{
    readonly ok: boolean
    readonly detail: string
    readonly failure?: FailureKind
  }>
  /**
   * 恢复时交给挂起节点的载荷。
   *
   * 只在「这一轮被某个信号唤醒、且当前节点正是当初挂起的那个」时有值；其余时候
   * undefined。节点自己判断要不要用它。
   */
  readonly signal?: Readonly<Record<string, unknown>>
  /** 写一条节点记录。 */
  record(entry: NodeRecordInput): void
  log(line: string): void
}

/** 一条待落盘的节点记录；由执行器补 id 与时间后交给存储。 */
export interface NodeRecordInput {
  readonly nodeId: string
  readonly type: string
  readonly ok: boolean
  readonly detail: string
  readonly failure?: FailureKind
  readonly sessionId?: string
  /** 结构化证据；**不得包含 `memory` 层的内容**。 */
  readonly data?: Readonly<Record<string, unknown>>
}

/** 一次失败的性质，决定还能做什么：去改配置 / 再试一次 / 只能放弃。 */

/** 挂起：这一轮停在这里，等信号再继续。 */
export interface SuspendSpec {
  readonly on: 'event' | 'human' | 'timer'
  /** `on: 'timer'` 时的到期时间（ISO）。 */
  readonly dueAt?: string
  /** 恢复时交给节点的载荷。 */
  readonly resume?: Readonly<Record<string, unknown>>
  /** 给人看的一句话：在等什么。 */
  readonly detail: string
}

/** 节点跑完的回答。 */
export type NodeResult =
  | {
      readonly ok: true
      readonly detail: string
      /** 产出的变量；按节点类型声明的 `outputs` 分派到 `vars` 或 `memory`。 */
      readonly output?: Readonly<Record<string, unknown>>
      /** 只走这些出边；缺省走全部。 */
      readonly next?: readonly string[]
      /** 建出的会话 id，链上会补一格。 */
      readonly sessionId?: string
      /** 回滚闭包；改了外部世界就登记。 */
      readonly undo?: () => Promise<void>
    }
  | {
      readonly ok: true
      /** 挂起：这一轮停在这里，等信号再继续。说明在 `suspend.detail` 里。 */
      readonly suspend: SuspendSpec
    }
  | {
      readonly ok: false
      readonly detail: string
      readonly failure?: FailureKind
      readonly next?: readonly string[]
      readonly sessionId?: string
    }

/**
 * 一种节点。
 *
 * 核心只提供这个接口与注册表：触发、分支、动作、循环全是它的实现。差别只在
 * `config`（声明长什么样）与 `run`（做什么）。
 */
export interface FlowNode {
  readonly type: string
  readonly label: string
  readonly group: NodeGroup
  /** 会不会改外部世界；撤销窗口与「不可撤销」提示据此判定。 */
  readonly sideEffect?: boolean
  /** 属性面板据此生成表单；缺省退化为 JSON 编辑。 */
  readonly config?: ConfigSchema
  /** 产出的变量键；解析期据此检查 `{var}` 有没有生产者。 */
  readonly outputs?: readonly OutputSpec[]
  /** 可换实现的节点列出候选；`spec.runner` 选其中一个。 */
  readonly runners?: readonly RunnerSpec[]
  /**
   * 跑一次。
   * @param spec - 图上的那个节点（含 `config` 与 `runner`）。
   * @param context - 这次执行的共享上下文。
   */
  run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult>
}

/* ─────────────────────────────── 进度 ─────────────────────────────── */

/** 一轮执行跑到哪了。随 Run 落盘，用于挂起恢复与崩溃续跑。 */
export interface FlowProgress {
  /** 已执行完的节点 id。 */
  readonly done: readonly string[]
  /** 已满足的边，形如 `from->to`。 */
  readonly satisfied: readonly string[]
  /** 待执行队列（已就绪但还没跑的节点）。 */
  readonly ready: readonly string[]
  /** 停在哪里；没有挂起时为 undefined。 */
  readonly suspendedAt?: string
  /** 这一轮挂起过几次；用于挡住死循环。 */
  readonly suspends: number
}

/** 一次执行的结果。 */
export interface FlowResult {
  readonly status: 'done' | 'partial' | 'skipped' | 'failed' | 'suspended'
  /** 挂起时的进度；否则等于跑完的进度。 */
  readonly progress: FlowProgress
  /** 命中的第一个带条件的节点说明（给人看）。 */
  readonly matched?: string
  /** 执行器自身出错时的说明（流程本身是好的）。 */
  readonly error?: string
}
