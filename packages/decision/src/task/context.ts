/**
 * 节点跑一次时能拿到的一切。
 *
 * 一个上下文，所有连接器共用——这是「一条链里混用不同连接器的动作」能成立的原因：
 * `markRead`（mail 提供）与 `session`（dsh 连接器提供）拿到的是**同一个** context，
 * 各自从 `ports` 里取自己那份端口，谁也不认识谁。
 *
 * `ports` 是唯一允许「核心不认识的东西」出现的地方。核心不 import 任何端口类型，
 * 连接器自己收窄（`context.ports.mail as MailPort`）。
 *
 * @module @free-lzj/dsh-decision/task/context
 */

import type { TaskEvent } from './event.ts'
import type { Task } from './record.ts'

/** 一次节点执行的环境。 */
export interface TaskContext {
  /** 这个任务（含它到这里为止的节点）。 */
  readonly task: Task
  /** 触发它的事件；重放时是同一份。 */
  readonly event: TaskEvent
  /** 动作模板里的变量（触发器给的，或规则里写死的）。 */
  readonly vars: Readonly<Record<string, string>>
  /** 正在跑的这格。 */
  readonly node: { readonly id: string; readonly kind: string }
  /** 各连接器挂上来的端口；按需取自己那份。 */
  readonly ports: Readonly<Record<string, unknown>>
  /** 现在；测试可以钉死。 */
  readonly now: Date
  log(line: string): void
}
