/**
 * 待撤销队列：有副作用的动作先排队，等撤销窗口过去再真正执行。
 *
 * 为什么要有这一层，而不是「做完再提供一个撤销按钮」：对外的副作用一旦发生，别人
 * （手机、网页端、同事）就已经看到了。先延迟再执行，等于把「撤销」从「尽力回滚」
 * 变成「根本没发生过」——这是市面产品里唯一被认为有效的做法。
 *
 * 队列**不解释自己存的是什么**：一条记录里除了调度用的 `id` / `dueAt` / `kind`，
 * 其余字段都是连接器的（邮件存那封邮件的坐标与摘要，Jira 存工单号），内核只是按
 * 到期时间排序、写盘、读回来。
 *
 * @module @free-lzj/dsh-decision/pending
 */

import { randomUUID } from 'node:crypto'
import { readJson, serialWriter } from './store.ts'

/**
 * 队列里一条记录的最低要求。
 *
 * `kind` 是这里唯一带语义的字段：`undo` 是「等撤销窗口过去再执行」，`suggest` 是
 * 「等人点同意，不点就永远不做」。两者共用一份队列与一份持久化，但**只有 `undo`
 * 会被到期扫描取走**——否则一条建议会在两分钟后悄悄变成自动执行，那正是「建议」
 * 这个词不该有的意思。
 */
export interface PendingRecord {
  readonly id: string
  /** ISO 时间；到期扫描按它比。 */
  readonly dueAt: string
  readonly kind: 'undo' | 'suggest'
  /** 建议对应的那个工作台条目 id（只有 `suggest` 有）。 */
  readonly itemId?: string
}

/** `pending.json` 的形状。 */
interface PendingFile<TRecord> {
  readonly version: 1
  readonly actions: readonly TRecord[]
}

/** 待撤销队列。 */
export interface PendingStore<TRecord extends PendingRecord> {
  /** 从磁盘读；坏文件回落成空队列。 */
  load(): Promise<void>
  /** 全部待执行项，按到期时间升序。 */
  list(): readonly TRecord[]
  /** 排入一条（`id` 由队列发）；返回它。 */
  add(input: Omit<TRecord, 'id'>): Promise<TRecord>
  /** 取消一条（撤销窗口里用户点了撤销，或建议被处理掉了）。 */
  cancel(id: string): Promise<boolean>
  /** 取出所有已到期的**撤销窗口项**并按到期顺序移除；调用方负责执行它们。 */
  takeDue(now: Date): Promise<readonly TRecord[]>
  /** 按工作台条目 id 找一条建议。 */
  findByItem(itemId: string): TRecord | undefined
}

/** 打开队列时要的形状说明。 */
export interface PendingStoreOptions<TRecord extends PendingRecord> {
  /** 文件路径；测试指到临时目录。 */
  readonly path: string
  /**
   * 把磁盘上的一条记录认回来；认不出返回 undefined（这条被丢掉）。
   *
   * 放在这里而不是写死在内核里，是因为「旧形状怎么兼容」是连接器自己的事：老文件
   * 里没有 `kind` 的那种写法，只有写过那个版本的连接器知道该怎么补。
   * @param value - 磁盘上的原始对象。
   * @returns 记录；不可信时为 undefined。
   */
  readonly parse: (value: unknown) => TRecord | undefined
}

/**
 * 打开待撤销队列。
 * @param options - 路径与「怎么把一条记录认回来」。
 * @returns 队列。
 */
export function createPendingStore<TRecord extends PendingRecord>(
  options: PendingStoreOptions<TRecord>,
): PendingStore<TRecord> {
  const write = serialWriter()
  let actions: TRecord[] = []

  /** 读整份文件。 */
  const parseFile = (value: unknown): PendingFile<TRecord> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const file = value as { version?: unknown; actions?: unknown }
    if (file.version !== 1 || !Array.isArray(file.actions)) return undefined
    return {
      version: 1,
      actions: file.actions.map(options.parse).filter((item): item is TRecord => item !== undefined),
    }
  }

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
      const item = { ...input, id: `pending-${randomUUID()}` } as TRecord
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
