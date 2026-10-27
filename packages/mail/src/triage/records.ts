/**
 * 两份「邮件形状」的记录：命中记录与待撤销队列。
 *
 * 存储本身在 `@free-lzj/dsh-decision` 里——它只管写盘、排序、裁剪，不认识邮件。这个
 * 文件是两者之间那一层：**一封邮件的记录长什么样、旧文件怎么认回来**。它存在的
 * 唯一理由是不让这套知识散在装配处与测试里各写一遍。
 *
 * @module @free-lzj/dsh-mail/triage/records
 */

import { createPendingStore, createRunStore, type PendingStore, type RunStore } from '@free-lzj/dsh-decision'
import type { MailEvent, PendingAction, Run } from './types.ts'

/**
 * 把记录里的那封邮件认回来。
 * @param value - 磁盘上的一条记录。
 * @returns 邮件；认不出时为 undefined（这条被丢掉）。
 */
export function mailEventOf(value: unknown): MailEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Readonly<Record<string, unknown>>
  // `message` 是抽包前的字段名；留着它是为了让用户已有的 runs.json 不当成坏文件。
  const event = record['event'] ?? record['message']
  if (typeof event !== 'object' || event === null) return undefined
  const candidate = event as Partial<MailEvent>
  if (typeof candidate.accountId !== 'string' || typeof candidate.folder !== 'string') return undefined
  if (typeof candidate.uid !== 'number' || typeof candidate.subject !== 'string') return undefined
  return candidate as MailEvent
}

/**
 * 打开这个插件的命中记录。
 * @param path - `runs.json` 的路径。
 * @returns 仓。
 */
export function createMailRunStore(path: string): RunStore<MailEvent> {
  return createRunStore<MailEvent>({ path, parseEvent: mailEventOf })
}

/**
 * 把队列里的一条待执行动作认回来。
 * @param value - 磁盘上的一条记录。
 * @returns 记录；字段不全时为 undefined。
 */
export function pendingOf(value: unknown): PendingAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Partial<PendingAction>
  if (typeof item.id !== 'string' || typeof item.dueAt !== 'string' || typeof item.runId !== 'string') return undefined
  if (typeof item.action !== 'object' || item.action === null) return undefined
  if (mailEventOf(item.message) === undefined) return undefined
  if (typeof item.summary !== 'object' || item.summary === null) return undefined
  // 老文件里没有 `kind`：那时候队列里只有撤销窗口项，所以补 `undo` 而不是丢弃。
  return { ...item, kind: item.kind === 'suggest' ? 'suggest' : 'undo' } as PendingAction
}

/**
 * 打开这个插件的待撤销队列。
 * @param path - `pending.json` 的路径。
 * @returns 队列。
 */
export function createMailPendingStore(path: string): PendingStore<PendingAction> {
  return createPendingStore<PendingAction>({ path, parse: pendingOf })
}

/** 一条记录里的邮件，供别处（页面、撤销）读。 */
export type MailRun = Run
