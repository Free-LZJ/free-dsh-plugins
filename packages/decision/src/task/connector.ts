/**
 * 连接器交给核心的一切。
 *
 * 这是「核心只提供接口，实现全在连接器」的落点。读完这个接口就该明白边界：
 *
 * - **触发器**：它自己监听外部世界，然后把事件 `emit` 进来。
 * - **动作**：它实现的节点，住在这里而不是核心。
 * - **条件与匹配计划**：条件词表属于它——核心不知道「邮件的 from 条件长什么样」。
 * - **分类**：它决定要不要分类、标签集是什么、怎么问模型。
 * - **建议**：它把「建议执行」推到工作台条目里（核心不知道条目是什么）。
 * - **迁移**：旧记录怎么变成任务，是它自己的历史。
 *
 * 核心在这一层**不做任何领域判断**：不认邮件、不认会话、不认 HTTP。
 *
 * @module @free-lzj/dsh-decision/task/connector
 */

import type { Condition } from '../registry.ts'
import type { DecisionConfigBase, RuleVocabulary } from '../config.ts'
import type { Rule } from '../types.ts'
import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import type { TaskContext } from './context.ts'
import type { MatchState } from '../match.ts'
import type { TaskEvent, TaskTrigger } from './event.ts'
import type { ActionNode, FailureKind, NodeOutcome, TaskNode } from './node.ts'
import type { FlowNode } from '../flow/types.ts'
import type { Task } from './record.ts'
import type { OwnedRegistry } from './registry.ts'

/** 试跑时那条事件在哪；字段名是连接器与页面共用的最小集合。 */
export interface TaskTestRef {
  readonly accountId: string
  readonly folder: string
  readonly uid: number
}

/** 试跑的答案：会命中哪条、会做什么、为什么。 */
export interface TaskTestView {
  readonly ruleId: string
  readonly ruleName: string
  readonly actions: readonly { readonly kind: string; readonly detail: string }[]
  readonly reason: string
  /** 逐条规则的匹配结果；规则是手写 YAML，配错是常态，这张表比一句话有用。 */
  readonly attempts: readonly TaskTestAttempt[]
}

/** 一条规则在试跑里为什么过/不过。 */
export interface TaskTestAttempt {
  readonly ruleId: string
  readonly ruleName: string
  readonly matched: boolean
  readonly reason: string
}

/** 试跑的两种结果：答案，或「没能跑」。 */
export type TaskTestAnswer =
  | { readonly ok: true; readonly result: TaskTestView }
  | { readonly ok: false; readonly message: string }

/* ─────────────────────────────── 分类 ─────────────────────────────── */

/** 一次分类要问的东西。 */
export interface ClassifySpec {
  /** 模型可选的全集标签。 */
  readonly labels: readonly string[]
  /** 给模型的额外说明。 */
  readonly prompt?: string
}

/** 分类节点的回答。 */
export interface ClassifyOutcome extends NodeOutcome {
  readonly label?: string
  readonly confidence?: number
  readonly model?: string
  /** 模型的原始回答摘要；卡片可展开看。 */
  readonly answer?: string
}

/** 分类节点：它也是 {@link TaskNode}。 */
export interface ClassifyNode extends TaskNode<ClassifySpec, TaskContext, ClassifyOutcome> {
  readonly kind: 'classify'
}

/**
 * 分类阶段的装配。
 *
 * `plan` 决定「这次要不要分类」——它从当前规则里收集标签集，空集就返回 undefined，
 * 于是整个分类阶段跳过、一次模型调用都不花。这条判断属于连接器，因为只有它知道
 * 自己的哪些条件会用到分类。
 */
export interface ClassifyPlan {
  readonly node: ClassifyNode
  plan(rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[]): ClassifySpec | undefined
}

/* ─────────────────────────────── 匹配 ─────────────────────────────── */

/** 一次匹配时连接器要造的两样东西。 */
export interface MatchRuntime {
  /** 为一个条件造上下文；`state` 在同一次匹配里是同一个对象。 */
  readonly context: (state: MatchState) => unknown
  /** 读正文；只在条件声明需要时调用，最多一次。 */
  readonly readBody: () => Promise<string>
}

/** 一次匹配的输入。 */
export interface MatchRequest {
  readonly task: Task
  readonly event: TaskEvent
  readonly ports: Readonly<Record<string, unknown>>
  /** 分类通道：一次任务只问一次，答案来自已经跑过的分类节点。 */
  readonly classification: () => Promise<{ readonly label: string; readonly confidence: number }>
  /**
   * 已经算好的分类结果。
   *
   * 节点图里 classify 是**一个节点**，它跑完就把结果放在这里；条件读到它就别再调
   * 一次模型。旧规则列表路径没有这个字段，条件会走 classification() 现问。
   */
  readonly facts?: { readonly label?: string; readonly confidence?: number }
}

/**
 * 连接器的匹配计划：条件注册表 + 怎么造上下文。
 *
 * 没有条件的连接器（只提供动作）可以不提供它；那样它的规则只能靠空 `when` 匹配。
 */
export interface Judge {
  readonly conditions: OwnedRegistry<Condition<ConditionSpecLike, unknown>>
  plan(request: MatchRequest): MatchRuntime
}

/* ─────────────────────────────── 迁移 ─────────────────────────────── */

/**
 * 旧命中记录的迁移。
 *
 * 「一条旧记录怎么变成任务」是连接器自己的历史（它要认得自己以前写下的形状），
 * 所以由它提供。核心只负责「`tasks.json` 还没有任务时跑一次」。
 */
export interface LegacyMigration {
  /** 旧记录文件的绝对路径（例：`runs.json`）。 */
  readonly path: string
  /**
   * 把一条旧记录收成任务。
   * @param record - 磁盘上的原始对象。
   * @returns 任务，或 undefined（这条认不出，丢掉）。
   */
  toTask(record: unknown): Task | undefined
}

/* ─────────────────────────────── 连接器 ─────────────────────────────── */

/** 一个连接器。 */
export interface TaskConnector {
  /** 全局唯一：`mail`、`dsh`、`jira`。 */
  readonly id: string
  readonly label: string
  /** 这个连接器承担的方向。 */
  readonly directions: readonly ('in' | 'out')[]
  /** 这个构建里入口是否真的可用；占位连接器写 false。 */
  readonly implemented: boolean
  /** 它今天做什么、刻意不做什么。 */
  readonly note?: string

  /** 它监听外部世界并 `emit` 的那些入口。 */
  readonly triggers: readonly TaskTrigger[]
  /** 它提供的动作节点（旧链式模型）。 */
  readonly actions: readonly ActionNode<ActionSpecLike, TaskContext>[]
  /**
   * 它贡献的**图节点**。
   *
   * 与 ctions 并存是过渡期的形态：旧规则列表走 ctions，节点图走这里。迁移完成、
   * 	hen 数组消失之后，ctions 会一起退役。
   */
  readonly nodes?: readonly FlowNode[]
  /** 它的条件词表与匹配计划；没有条件的连接器可以省略。 */
  readonly judge?: Judge
  /** 它的分类阶段；不分类的连接器可以省略。 */
  readonly classify?: ClassifyPlan
  /** 它挂到上下文里的端口。 */
  readonly ports?: Readonly<Record<string, unknown>>
  /** 规则文件的语法与发货默认规则。 */
  readonly vocabulary: RuleVocabulary<ConditionSpecLike, ActionSpecLike>
  readonly defaultRules: string
  /**
   * 判定层的那几个开关（总开关、试运行、撤销窗口、保留策略）。
   *
   * 工作台不持有它们——它们属于「谁提供规则」的那一侧（邮件的 `triage` 配置就是）。
   * 一个引擎有多个连接器时，用第一个提供的那份。
   */
  readonly decisionConfig?: () => DecisionConfigBase
  /**
   * 拿一条真实事件试跑当前规则；引擎不认识事件，所以由连接器回答。
   *
   * 规则作为第二个参数交进来，是因为「哪些规则属于我」与「现在生效的是哪一份」都是
   * 引擎才知道的事；连接器不该自己再读一遍规则文件。
   */
  readonly test?: (
    ref: TaskTestRef,
    rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[],
  ) => Promise<TaskTestAnswer>
  /** 旧数据目录：启动时把这些目录下的状态搬进引擎目录（只搬不删）。 */
  readonly legacyHomes?: readonly string[]
  /** 旧命中记录怎么写成一个任务。 */
  readonly migration?: LegacyMigration
}

/** 一个失败原因的分类，转给节点记录。 */
export type { FailureKind }
