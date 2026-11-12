/**
 * 延迟与建议：还没发生的动作住在哪。
 *
 * 两种记录共用一份文件，因为它们是同一个问题的两个答案：
 *
 * - `delay`：有副作用的动作先排队，等撤销窗口过去再真做。窗口内撤销是**取消**
 *   （没发生过），窗口外是**回滚**（发生了再倒回去）——语义不同，风险也不同。
 * - `suggest`：等人点同意；**不点就永远不做**。到期扫描不碰它，否则一条建议会在
 *   两分钟后悄悄变成自动执行。
 *
 * 记录里除了调度字段（`taskId` / `nodeId` / `dueAt` / `kind`）其余都是连接器的
 * 动作配置，核心原样保存、原样交回。
 *
 * 旧的 `pending.json` 不迁移：它是分钟级的窗口，重启即失效，而用户不会因此丢东西
 * （动作要么没发生，要么已经发生）。
 *
 * @module @free-lzj/dsh-decision/task/deferred
 */

import { randomUUID } from 'node:crypto'
import { readJson, serialWriter } from '../store.ts'
import type { ActionSpecLike } from '../registry.ts'

/** 一条还没发生的动作。 */
export interface DeferredRecord {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  /** 哪个连接器提供这个动作；到期执行时用它选词表。 */
  readonly connector: string
  /** `delay` 会被到期扫描取走；`suggest` 不会。 */
  readonly kind: 'delay' | 'suggest'
  /** 动作配置原样保存。 */
  readonly spec: ActionSpecLike
  /** ISO 时间。 */
  readonly dueAt: string
  /** 建议对应的条目 id（只有 `suggest` 有）。 */
  readonly itemId?: string
}

/** `deferred.json` 的形状。 */
interface DeferredFile {
  readonly version: 1
  readonly records: readonly DeferredRecord[]
}

/** 队列。 */
export interface DeferredStore {
  load(): Promise<void>
  list(): readonly DeferredRecord[]
  add(input: Omit<DeferredRecord, 'id'>): Promise<DeferredRecord>
  /** 取出所有到期的 `delay` 并移除；调用方负责执行。 */
  takeDue(now: Date): Promise<readonly DeferredRecord[]>
  /** 取消某个任务下还没发生的动作；返回取消了几条。 */
  cancelByTask(taskId: string): Promise<number>
  /** 某个任务下还没发生的动作。 */
  byTask(taskId: string): readonly DeferredRecord[]
  /** 按条目 id 找一条建议。 */
  findByItem(itemId: string): DeferredRecord | undefined
  /** 移除一条（建议被执行/丢弃后）。 */
  remove(id: string): Promise<boolean>
}

/**
 * 打开队列。
 * @param path - `deferred.json` 的绝对路径；测试指到临时目录。
 * @returns 队列。
 */
export function createDeferredStore(path: string): DeferredStore {
  const write = serialWriter()
  let records: DeferredRecord[] = []

  const parseFile = (value: unknown): DeferredFile | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const file = value as { version?: unknown; records?: unknown }
    if (file.version !== 1 || !Array.isArray(file.records)) return undefined
    return { version: 1, records: file.records as readonly DeferredRecord[] }
  }

  /** 按到期时间排好再写盘一次。 */
  async function persist(): Promise<void> {
    const ordered = [...records].sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    records = ordered
    await write(path, `${JSON.stringify({ version: 1, records: ordered }, null, 2)}\n`)
  }

  return {
    async load() {
      const file = await readJson<DeferredFile>(path, parseFile, { version: 1, records: [] })
      records = [...file.records].sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    },
    list: () => [...records],
    async add(input) {
      const record: DeferredRecord = { ...input, id: `deferred-${randomUUID()}` }
      records = [...records, record]
      await persist()
      return record
    },
    async takeDue(now) {
      const nowIso = now.toISOString()
      // 只取 `delay`：`suggest` 是等人的，到期扫描碰它就是「建议变自动」。
      const due = records.filter(record => record.kind === 'delay' && record.dueAt <= nowIso)
      if (due.length === 0) return []
      const taken = new Set(due.map(record => record.id))
      records = records.filter(record => !taken.has(record.id))
      await persist()
      return due
    },
    async cancelByTask(taskId) {
      const before = records.length
      records = records.filter(record => record.taskId !== taskId)
      if (records.length === before) return 0
      await persist()
      return before - records.length
    },
    byTask: taskId => records.filter(record => record.taskId === taskId),
    findByItem: itemId => records.find(record => record.itemId === itemId),
    async remove(id) {
      const before = records.length
      records = records.filter(record => record.id !== id)
      if (records.length === before) return false
      await persist()
      return true
    },
  }
}
