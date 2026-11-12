/**
 * 任务与节点记录：工作台唯一的「发生过什么」。
 *
 * 一个 {@link Task} 是一个事件被触发器选中后的实体；它的 `nodes` 就是那条链，按发生
 * 顺序排。**会话是链上的一个节点**（`kind: 'session'`），不是动作身上的一个字段——
 * 这样"点进去看它在说什么"与"它属于哪件事"是同一份数据。
 *
 * 设计上刻意保留两件事：
 *
 * 1. **`key` 是任务身份**，由触发器给出。同一件事的第二封信、重试、后续动作都归到
 *    同一个 `key`，因此看板上永远只有一张卡。聚合从浏览器搬回这里，前端不再猜。
 * 2. **`data` 是节点的结构化证据**（事件摘要、分类标签、规则 id、动作配置），给重放
 *    与「展开看它到底做了什么」用。`detail` 只是给人看的一行字，不该被机器解析。
 *
 * @module @free-lzj/dsh-decision/task/record
 */

import type { FailureKind } from './node.ts'
import type { TaskEvent } from './event.ts'

/** 一条任务走到哪了。 */
export type TaskStatus = 'running' | 'done' | 'partial' | 'skipped' | 'failed' | 'undone'

/** 链上的一格。 */
export interface TaskNodeRecord {
  readonly id: string
  /** `trigger` | `classify` | `rule` | 动作 kind | `session`。 */
  readonly kind: string
  /** ISO 时间。 */
  readonly at: string
  readonly ok: boolean
  /** 给人看的一行；失败时含原因。 */
  readonly detail: string
  readonly failure?: FailureKind
  /** 它在命中规则的 `then` 里的位置；重放与回填用。 */
  readonly actionIndex?: number
  /** 只有会话节点（与建了会话的动作）才有。 */
  readonly sessionId?: string
  /** 结构化证据：事件摘要、分类标签、规则 id、动作配置、会话状态。 */
  readonly data?: Readonly<Record<string, unknown>>
}

/** 一个任务。 */
export interface Task {
  readonly id: string
  /** 触发它的连接器；规则按它过滤（条件词表属于连接器）。 */
  readonly connector: string
  /** 谁接的；排障用。 */
  readonly triggerId: string
  /** 任务身份，由触发器给。 */
  readonly key: string
  /** 事件身份，由连接器给；`dedupeKey` 命中时用它找既有任务。 */
  readonly eventKey?: string
  readonly title: string
  /** ISO 时间。 */
  readonly at: string
  readonly updatedAt: string
  readonly status: TaskStatus
  readonly nodes: readonly TaskNodeRecord[]
  /** 有副作用且已结束 → 结果待确认。 */
  readonly awaitingConfirmation?: boolean
  /** 人已经说过「这条我看到了」。 */
  readonly acknowledged?: boolean
  /** 延迟动作的撤销窗口截止时间。 */
  readonly undoableUntil?: string
  /** 触发它的事件（可序列化），重放用。 */
  readonly event: TaskEvent
  /** 动作模板里能用的变量。 */
  readonly vars: Readonly<Record<string, string>>
}

/** 连接器回写节点时要改的那几个字段。 */
export interface NodePatch {
  readonly detail?: string
  readonly ok?: boolean
  readonly failure?: FailureKind
  readonly data?: Readonly<Record<string, unknown>>
}

/** 任务状态的一次变化。 */
export interface TaskPatch {
  readonly status?: TaskStatus
  readonly awaitingConfirmation?: boolean
  readonly acknowledged?: boolean
  readonly undoableUntil?: string
  readonly updatedAt?: string
}

/** 一个连接器在看板上长什么样。 */
export interface TaskConnectorInfo {
  readonly id: string
  readonly label: string
  readonly directions: readonly ('in' | 'out')[]
  readonly implemented: boolean
  readonly note?: string
  /**
   * 它参不参与规则。
   *
   * 关掉一个连接器 = 撤掉它的触发器与动作注册，但**不卸载插件**：邮件面板还开着，
   * 只是规则不再从它的事件里派活。这是「面板」与「规则」分开的落点。
   */
  readonly enabled: boolean
  /** 它注册的触发器 id，给连接器页展示「能接什么事件」。 */
  readonly triggers: readonly string[]
  /** 它注册的动作 kind，给规则页提示可用动作。 */
  readonly actions: readonly string[]
}

/** 看板与规则页读的那份快照。 */
export interface TaskState {
  readonly tasks: readonly Task[]
  readonly connectors: readonly TaskConnectorInfo[]
  /** 规则文件视图（不含原文，原文由规则页单独读）。 */
  readonly revision: number
}
