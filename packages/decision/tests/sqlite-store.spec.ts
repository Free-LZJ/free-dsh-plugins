/**
 * SQLite 实现：与 JSON 实现同一套契约。
 *
 * 直接测实现本身（绕过 `openTaskStore` 的探测），因为「有 SQLite 就用」在 CI 上
 * 不一定成立——但实现对了，切过去才安全。
 *
 * @module @free-lzj/dsh-decision/tests/sqlite-store
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteTaskStore } from '../src/task/sqlite-store.ts'
import type { Task, TaskNodeRecord } from '../src/task/record.ts'

/** 一条任务。 */
function taskOf(id: string, updatedAt: string): Task {
  return {
    id,
    connector: 'mail',
    triggerId: 'mail:new',
    key: `mail:${id}`,
    eventKey: `mail:${id}`,
    title: `事件 ${id}`,
    at: updatedAt,
    updatedAt,
    status: 'done',
    nodes: [],
    event: { type: 'mail.received', source: 'mail', payload: {} },
    vars: {},
  }
}

/** 一个新库的目录。 */
function dirOf(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-sqlite-'))
}

describe('SQLite 任务仓', () => {
  it('写入、按 id/key 读回', async () => {
    const store = await createSqliteTaskStore(dirOf(), () => undefined)
    await store.load()
    await store.create(taskOf('a', '2026-11-11T01:00:00.000Z'))
    expect(store.count()).toBe(1)
    expect(store.get('a')?.title).toBe('事件 a')
    expect(store.byKey('mail:a')?.id).toBe('a')
    expect(store.byEventKey('mail:a')?.id).toBe('a')
  })

  it('追加节点只改那一行，顺序保留', async () => {
    const store = await createSqliteTaskStore(dirOf(), () => undefined)
    await store.load()
    await store.create(taskOf('a', '2026-11-11T01:00:00.000Z'))
    const node: TaskNodeRecord = { id: 'n1', kind: 'rule', at: '2026-11-11T01:01:00.000Z', ok: true, detail: '命中' }
    const next = await store.appendNode('a', node)
    expect(next?.nodes).toHaveLength(1)
    expect(store.get('a')?.nodes[0]?.detail).toBe('命中')
  })

  it('list 按更新时间由新到旧', async () => {
    const store = await createSqliteTaskStore(dirOf(), () => undefined)
    await store.load()
    await store.create(taskOf('old', '2026-11-01T00:00:00.000Z'))
    await store.create(taskOf('new', '2026-11-11T00:00:00.000Z'))
    expect(store.list().map(task => task.id)).toEqual(['new', 'old'])
  })

  it('裁剪留最新的，且 limit: 0 表示不限', async () => {
    const store = await createSqliteTaskStore(dirOf(), () => undefined)
    await store.load()
    for (const day of ['01', '02', '03']) {
      await store.create(taskOf(day, `2026-11-${day}T00:00:00.000Z`))
    }
    await store.trim({ limit: 2, days: 0 }, new Date('2026-11-30T00:00:00.000Z'))
    expect(store.list().map(task => task.id)).toEqual(['03', '02'])
    await store.trim({ limit: 0, days: 0 }, new Date('2026-11-30T00:00:00.000Z'))
    expect(store.count()).toBe(2)
  })

  it('days: 0 不按天数裁（不是全部过期）', async () => {
    const store = await createSqliteTaskStore(dirOf(), () => undefined)
    await store.load()
    await store.create(taskOf('ancient', '2020-01-01T00:00:00.000Z'))
    await store.trim({ limit: 0, days: 0 }, new Date('2026-11-11T00:00:00.000Z'))
    expect(store.count()).toBe(1)
  })

  it('空库时从 tasks.json 导入，旧文件保留', async () => {
    const dir = dirOf()
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [taskOf('legacy', '2026-11-10T00:00:00.000Z')] }))
    const store = await createSqliteTaskStore(dir, () => undefined)
    await store.load()
    expect(store.count()).toBe(1)
    expect(store.get('legacy')?.title).toBe('事件 legacy')
  })
})
