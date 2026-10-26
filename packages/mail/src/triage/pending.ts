/**
 * 待撤销队列：有副作用的动作先排队，等撤销窗口过去再真正执行。
 *
 * 为什么要有这一层，而不是「做完再提供一个撤销按钮」：IMAP 的移动与已读是**可见的
 * 副作用**，一旦发生，别人（手机、网页端、同事）就已经看到了。先延迟再执行，等于把
 * 「撤销」从「尽力回滚」变成「根本没发生过」——这是市面产品里唯一被认为有效的做法。
 *
 * 排队的动作**不含正文**：等 120 秒之后再去读一次正文比在磁盘上留一份邮件内容安全，
 * 而且正文本来就可能已经变了（大附件、被服务器清掉）。
 *
 * @module @free-lzj/dsh-mail/triage/pending
 */

import { randomUUID } from 'node:crypto'
import { readJson, serialWriter } from './store.ts'
import type { ActionSpec, MailSummaryLike, PendingAction, Run } from './types.ts'

/** `pending.json` 的形状。 */
interface PendingFile {
  readonly version: 1
  readonly actions: readonly PendingAction[]
}

/** 一条待执行动作加上它的调度身份。 */
export interface QueuedAction extends PendingAction {}

/** 待撤销队列。 */
export interface PendingStore {
  /** 从磁盘读；坏文件回落成空队列。 */
  load(): Promise<void>
  /** 全部待执行项，按到期时间升序。 */
  list(): readonly PendingAction[]
  /** 排入一条；返回它。 */
  add(input: {
    readonly runId: string
    readonly ruleId: string
    readonly actionIndex: number
    readonly action: ActionSpec
    readonly message: Run['message']
    readonly summary: MailSummaryLike
    readonly dueAt: string
    readonly kind: 'undo' | 'suggest'
    readonly itemId?: string
  }): Promise<PendingAction>
  /** 取消一条（撤销窗口里用户点了撤销，或建议被处理掉了）。 */
  cancel(id: string): Promise<boolean>
  /** 取出所有已到期的**撤销窗口项**并按到期顺序移除；调用方负责执行它们。 */
  takeDue(now: Date): Promise<readonly PendingAction[]>
  /** 按工作台条目 id 找一条建议。 */
  findByItem(itemId: string): PendingAction | undefined
}

/** 读一条；字段不全就当它不可信。 */
function parsePending(value: unknown): PendingAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Partial<PendingAction>
  if (typeof item.id !== 'string' || typeof item.dueAt !== 'string' || typeof item.runId !== 'string') return undefined
  if (typeof item.action !== 'object' || item.action === null) return undefined
  if (typeof item.message !== 'object' || item.message === null) return undefined
  if (typeof item.summary !== 'object' || item.summary === null) return undefined
  // 老文件里没有 `kind`：那时候队列里只有撤销窗口项，所以补 `undo` 而不是丢弃。
  return { ...item, kind: item.kind === 'suggest' ? 'suggest' : 'undo' } as PendingAction
}

/** 读整份文件。 */
function parseFile(value: unknown): PendingFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as { version?: unknown; actions?: unknown }
  if (file.version !== 1 || !Array.isArray(file.actions)) return undefined
  return { version: 1, actions: file.actions.map(parsePending).filter((item): item is PendingAction => item !== undefined) }
}

/**
 * 打开待撤销队列。
 * @param options - `path` 是 `pending.json`。
 * @returns 队列。
 */
export function createPendingStore(options: { readonly path: string }): PendingStore {
  const write = serialWriter()
  let actions: PendingAction[] = []

  /** 按到期时间排好再写盘一次。 */
  async function persist(): Promise<void> {
    const ordered = [...actions].sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    actions = ordered
    await write(options.path, `${JSON.stringify({ version: 1, actions: ordered }, null, 2)}\n`)
  }

  return {
    async load() {
      const file = await readJson(options.path, parseFile, { version: 1, actions: [] })
      actions = [...file.actions].sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    },
    list: () => [...actions],
    async add(input) {
      const item: PendingAction = {
        id: `pending-${randomUUID()}`,
        runId: input.runId,
        ruleId: input.ruleId,
        actionIndex: input.actionIndex,
        action: input.action,
        message: input.message,
        summary: input.summary,
        dueAt: input.dueAt,
        kind: input.kind,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      }
      actions = [...actions, item]
      await persist()
      return item
    },
    async cancel(id) {
      const before = actions.length
      actions = actions.filter(item => item.id !== id)
      if (actions.length === before) return false
      await persist()
      return true
    },
    async takeDue(now) {
      const nowIso = now.toISOString()
      // 只取 `undo`：`suggest` 项是等人的，到期扫描碰它就是「建议变自动」。
      const due = actions.filter(item => item.kind === 'undo' && item.dueAt <= nowIso)
      if (due.length === 0) return []
      const taken = new Set(due.map(item => item.id))
      actions = actions.filter(item => !taken.has(item.id))
      await persist()
      return due
    },
    findByItem(itemId) {
      return actions.find(item => item.itemId === itemId)
    },
  }
}
