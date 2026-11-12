/**
 * 事件与触发器：连接器怎么把外部世界的一件事交给工作台。
 *
 * 分成两层，这是整套架构的关键取舍（见 `docs/architecture.md`）：
 *
 * - **事件是数据**。连接器负责监听外部世界（收信、轮询、HTTP 路由），然后把一个
 *   可序列化的 {@link TaskEvent} 发出来。核心不解释它，也不订阅任何人。
 * - **触发器是第一类对象**。它是一段可注册、可列出、可禁用的声明：听哪些事件类型、
 *   什么条件下接、怎么把它变成一个**任务种子**。
 *
 * `emit` 的语义是**首命中不扇出**：按 `priority` 追问触发器，第一个接手的决定任务，
 * 立刻停止。一个事件因此至多产生一个任务——这既是最初「同一件事在板上变成好几张卡」
 * 的病根，也是这里最简单的解法。
 *
 * @module @free-dsh-decision/task/event
 */

import type { NodeOutcome, TaskNode } from './node.ts'

/**
 * 一个外部事件。
 *
 * `payload` 必须是**可 JSON 序列化**的：任务落盘之后要靠它重放（延迟动作到期、
 * 建议被批准、重启后继续）。函数、句柄、流都不能放进来——要读正文就放坐标，由
 * 连接器的端口在需要时再读一次。
 */
export interface TaskEvent {
  /** 事件类型，由连接器命名：`mail.received`、`webhook.push`、`console.tool.invoked`。 */
  readonly type: string
  /** 哪个连接器发的。 */
  readonly source: string
  /** 连接器自己的形状；核心只透传。 */
  readonly payload: unknown
  /**
   * 同一件事的身份，例：`mail:账号:目录:uid`。
   *
   * 它挡住的是「同一个事实重复到达」：命中时不再跑链，直接返回既有任务。它与
   * {@link TriggerSeed.key} 不是一回事——后者是任务身份，不同事件可以落到同一个
   * 任务上（同一工单的第二封信）。
   */
  readonly dedupeKey?: string
}

/** 触发器接下一个事件时给出的任务身份。 */
export interface TriggerSeed {
  /** 任务身份。同一个 key 的后续事件会**追加**到同一条链。 */
  readonly key: string
  /** 卡片标题。 */
  readonly title: string
  /** 动作模板里能用的变量。 */
  readonly vars?: Readonly<Record<string, string>>
}

/** 触发器跑完的回答；它比节点多一个「要不要建任务」。 */
export interface TriggerOutcome extends NodeOutcome {
  /** 接了这个事件：任务种子。没有 seed 表示「看到了但不接」（`stop`）。 */
  readonly seed?: TriggerSeed
}

/** 触发器跑的时候能拿到的东西。任务还没建，所以没有 `task`。 */
export interface TriggerContext {
  readonly event: TaskEvent
  /** 连接器挂上来的端口（按需取自己那份）。 */
  readonly ports: Readonly<Record<string, unknown>>
  /** 现在；测试可以钉死。 */
  readonly now: Date
  log(line: string): void
}

/**
 * 事件节点：**它就是 {@link TaskNode}**，`spec` 就是事件本身。
 *
 * 这样「事件也实现任务节点接口」不是比喻。`run` 负责回答两件事：这个事件我接不接，
 * 接了它是什么任务。
 */
export interface TaskTrigger extends TaskNode<TaskEvent, TriggerContext, TriggerOutcome> {
  readonly kind: 'trigger'
  /** 全局唯一的触发器 id：`mail:new`、`console:tool`。 */
  readonly id: string
  /** 哪个连接器注册的。 */
  readonly connector: string
  /** 订阅哪些事件类型。 */
  readonly listensTo: readonly string[]
  /** 同一类型下的分流顺序：升序追问，小者先。缺省按注册顺序 × 10。 */
  readonly priority?: number
  /** 同一类型下按内容分流；返回 false 表示「这个事件不归我」。 */
  match?(event: TaskEvent): boolean
}

/** 一次 `emit` 的答案：谁接的、产出了哪个任务、谁没接。 */
export interface EmitAck {
  /** 有没有触发器接下它。`false` 时连接器该自己告警——沉默的丢弃最难查。 */
  readonly handled: boolean
  readonly taskId?: string
  /** 接下它的触发器 id。 */
  readonly triggerId?: string
  /** `dedupeKey` 命中：任务早就有了，这次没有跑链。 */
  readonly duplicate?: boolean
  /** 按 priority 追问过但没接的，附原因（`no-match` / `declined` / `duplicate`）。 */
  readonly skipped: readonly { readonly triggerId: string; readonly reason: string }[]
}
