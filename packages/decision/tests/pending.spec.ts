/**
 * 待撤销队列：排序、取消、到期取走，以及**只有 `undo` 会被到期扫描碰到**。
 *
 * 最后一条是这个模块存在的理由：一条「建议」如果在两分钟后被当成到期的撤销窗口
 * 项执行掉，用户看到的就是「建议自己执行了」——那比没有建议更糟。
 *
 * @module @free-lzj/dsh-decision/tests/pending
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPendingStore, type PendingRecord } from '../src/pending.ts'

/** 测试用的记录：内核在意的三个字段 + 连接器自己的两坨东西。 */
interface QueuedItem extends PendingRecord {
  readonly ruleId: string
  readonly extra: Readonly<Record<string, unknown>>
}

const paths: string[] = []

/** 一个临时目录，测试结束删掉。 */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-decision-pending-'))
  paths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** 认一条记录：三个调度字段齐全就算可信。 */
function parse(value: unknown): QueuedItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Partial<QueuedItem>
  if (typeof item.id !== 'string' || typeof item.dueAt !== 'string') return undefined
  if (typeof item.ruleId !== 'string' || typeof item.extra !== 'object' || item.extra === null) return undefined
  return { ...item, kind: item.kind === 'suggest' ? 'suggest' : 'undo' } as QueuedItem
}

/** 一条待排入的记录。 */
function entry(overrides: Partial<Omit<QueuedItem, 'id'>> = {}): Omit<QueuedItem, 'id'> {
  return { dueAt: '2026-10-27T10:00:00.000Z', kind: 'undo', ruleId: 'github', extra: {}, ...overrides }
}

describe('createPendingStore', () => {
  it('keeps the queue sorted by due time, whichever order things arrive in', async () => {
    const home = await scratch()
    const store = createPendingStore<QueuedItem>({ path: join(home, 'pending.json'), parse })
    await store.load()
    await store.add(entry({ dueAt: '2026-10-27T12:00:00.000Z' }))
    await store.add(entry({ dueAt: '2026-10-27T10:00:00.000Z' }))
    expect(store.list().map(item => item.dueAt)).toEqual([
      '2026-10-27T10:00:00.000Z',
      '2026-10-27T12:00:00.000Z',
    ])
  })

  it('takes only the undo entries that are due, and leaves suggestions alone', async () => {
    const home = await scratch()
    const store = createPendingStore<QueuedItem>({ path: join(home, 'pending.json'), parse })
    await store.load()
    await store.add(entry({ dueAt: '2026-10-27T09:00:00.000Z', kind: 'undo', ruleId: 'due' }))
    await store.add(entry({ dueAt: '2026-10-27T20:00:00.000Z', kind: 'undo', ruleId: 'later' }))
    // 一条同期的建议：到期扫描碰它就是「建议自己执行了」。
    await store.add(entry({ dueAt: '2026-10-27T09:00:00.000Z', kind: 'suggest', ruleId: 'suggestion' }))

    const taken = await store.takeDue(new Date('2026-10-27T10:00:00.000Z'))
    expect(taken.map(item => item.ruleId)).toEqual(['due'])
    expect(store.list().map(item => item.ruleId)).toEqual(['suggestion', 'later'])
  })

  it('cancels one entry and answers whether it existed', async () => {
    const home = await scratch()
    const store = createPendingStore<QueuedItem>({ path: join(home, 'pending.json'), parse })
    await store.load()
    const item = await store.add(entry())
    expect(await store.cancel(item.id)).toBe(true)
    expect(await store.cancel(item.id)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('finds a suggestion by the workbench item it was raised as', async () => {
    const home = await scratch()
    const store = createPendingStore<QueuedItem>({ path: join(home, 'pending.json'), parse })
    await store.load()
    const suggestion = await store.add(entry({ kind: 'suggest', itemId: 'item-1' }))
    expect(store.findByItem('item-1')?.id).toBe(suggestion.id)
    expect(store.findByItem('item-2')).toBeUndefined()
  })

  it('writes what a later load reads back, in due order', async () => {
    const home = await scratch()
    const path = join(home, 'pending.json')
    const store = createPendingStore<QueuedItem>({ path, parse })
    await store.load()
    await store.add(entry({ dueAt: '2026-10-27T12:00:00.000Z', ruleId: 'late' }))
    await store.add(entry({ dueAt: '2026-10-27T10:00:00.000Z', ruleId: 'early' }))

    const reopened = createPendingStore<QueuedItem>({ path, parse })
    await reopened.load()
    expect(reopened.list().map(item => item.ruleId)).toEqual(['early', 'late'])
  })

  it('fills in the missing kind of an older file instead of dropping the entry', async () => {
    const home = await scratch()
    const path = join(home, 'pending.json')
    // 老文件：那时队列里只有撤销窗口项，所以没有 `kind` 字段。
    const legacy = { version: 1, actions: [{ id: 'pending-1', dueAt: '2026-10-27T10:00:00.000Z', ruleId: 'r', extra: {} }] }
    await writeFile(path, JSON.stringify(legacy), 'utf8')
    const store = createPendingStore<QueuedItem>({ path, parse })
    await store.load()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.kind).toBe('undo')
  })

  it('starts empty when the file is unreadable instead of throwing', async () => {
    const home = await scratch()
    const path = join(home, 'pending.json')
    await writeFile(path, 'not json at all', 'utf8')
    const store = createPendingStore<QueuedItem>({ path, parse })
    await store.load()
    expect(store.list()).toEqual([])
  })

  it('keeps the file shape the connector already had', async () => {
    const home = await scratch()
    const path = join(home, 'pending.json')
    const store = createPendingStore<QueuedItem>({ path, parse })
    await store.load()
    await store.add(entry({ ruleId: 'github' }))
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: number; actions: unknown[] }
    expect(written.version).toBe(1)
    expect(written.actions).toHaveLength(1)
  })
})
