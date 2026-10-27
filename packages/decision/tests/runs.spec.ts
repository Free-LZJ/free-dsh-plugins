/**
 * 命中记录这一层：追加、撤销、裁剪，以及**旧记录能不能读回来**。
 *
 * 最后一点是这次抽包时唯一的真实风险：文件里已经有用户的历史，形状变了不能当成
 * 坏文件丢掉。所以这里把「连接器自己的 parseEvent 决定兼容」钉死。
 *
 * @module @free-lzj/dsh-decision/tests/runs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunStore, type Run } from '../src/runs.ts'

/** 测试用的事件形状（内核不关心它长什么样）。 */
interface Event {
  readonly id: string
  readonly title: string
}

const paths: string[] = []

/** 一个临时目录，测试结束删掉。 */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-decision-runs-'))
  paths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** 认新形状：`event` 上有 id 与 title。 */
function parseEvent(record: Readonly<Record<string, unknown>>): Event | undefined {
  const event = record['event'] as { id?: unknown; title?: unknown } | undefined
  if (event === undefined || event === null) return undefined
  if (typeof event.id !== 'string' || typeof event.title !== 'string') return undefined
  return { id: event.id, title: event.title }
}

/** 一条可直接写盘的记录（含 id）。 */
function record(overrides: Partial<Run<Event>> = {}): Run<Event> {
  return {
    id: 'run-1',
    at: '2026-10-27T08:00:00.000Z',
    ruleId: 'github',
    ruleName: 'GitHub 通知',
    label: 'github',
    event: { id: 'e1', title: 'Run failed' },
    actions: [{ kind: 'archive', mode: 'auto', ok: true, detail: '已归档' }],
    status: 'done',
    ...overrides,
  }
}

/** 一条「还没写进仓」的记录：id 由仓来发。 */
function fresh(overrides: Partial<Omit<Run<Event>, 'id'>> = {}): Omit<Run<Event>, 'id'> {
  const { id: _id, ...rest } = record()
  return { ...rest, ...overrides }
}

describe('createRunStore', () => {
  it('appends newest first and answers the same records back', async () => {
    const home = await scratch()
    const store = createRunStore<Event>({ path: join(home, 'runs.json'), parseEvent })
    await store.load()
    const first = await store.append(fresh())
    const second = await store.append(fresh({ ruleId: 'promo' }))
    expect(store.list().map(run => run.id)).toEqual([second.id, first.id])
    expect(store.get(first.id)?.event.title).toBe('Run failed')
  })

  it('writes what a later load reads back, in the same order', async () => {
    const home = await scratch()
    const path = join(home, 'runs.json')
    const store = createRunStore<Event>({ path, parseEvent })
    await store.load()
    await store.append(fresh())
    await store.append(fresh({ ruleId: 'second' }))

    const reopened = createRunStore<Event>({ path, parseEvent })
    await reopened.load()
    expect(reopened.list().map(run => run.ruleId)).toEqual(['second', 'github'])
  })

  it('patches one record into another status without touching the rest', async () => {
    const home = await scratch()
    const store = createRunStore<Event>({ path: join(home, 'runs.json'), parseEvent })
    await store.load()
    const run = await store.append(fresh())
    const patched = await store.patch(run.id, { status: 'undone' })
    expect(patched?.status).toBe('undone')
    expect(patched?.event).toEqual(run.event)
    expect(await store.patch('missing', { status: 'undone' })).toBeUndefined()
  })

  it('trims by age first, then by count', async () => {
    const home = await scratch()
    const store = createRunStore<Event>({ path: join(home, 'runs.json'), parseEvent })
    await store.load()
    await store.append(fresh({ at: '2026-01-01T00:00:00.000Z' }))
    await store.append(fresh({ at: '2026-10-26T00:00:00.000Z' }))
    await store.append(fresh({ at: '2026-10-27T00:00:00.000Z' }))
    // 先按天数（30 天）把 1 月那条裁掉，再按条数（1 条）留下一半。
    await store.trim({ limit: 1, days: 30 }, new Date('2026-10-27T12:00:00.000Z'))
    expect(store.list().length).toBe(1)
    expect(store.list()[0]?.at).toBe('2026-10-27T00:00:00.000Z')
  })

  it('reads records the connector wrote in an older shape', async () => {
    const home = await scratch()
    const path = join(home, 'runs.json')
    // 旧文件：事件叫 `message`，且没有 `event`。连接器自己的 parseEvent 负责认它。
    const legacy = {
      version: 1,
      runs: [{ ...record(), event: undefined, message: { id: 'e1', title: 'Run failed' } }],
    }
    await writeFile(path, JSON.stringify(legacy), 'utf8')
    const store = createRunStore<Event>({
      path,
      parseEvent: (raw) => {
        const event = raw['event'] ?? raw['message']
        return parseEvent({ event })
      },
    })
    await store.load()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.event).toEqual({ id: 'e1', title: 'Run failed' })
    // 再写一次时已经换成新形状：迁移是渐进的，不是一次性的脚本。
    await store.append(fresh({ ruleId: 'second' }))
    const written = JSON.parse(await readFile(path, 'utf8')) as { runs: { event?: unknown; message?: unknown }[] }
    expect(written.runs.every(entry => entry.event !== undefined && entry.message === undefined)).toBe(true)
  })

  it('drops records whose event it cannot recognise, and keeps the rest', async () => {
    const home = await scratch()
    const path = join(home, 'runs.json')
    const file = {
      version: 1,
      runs: [
        { ...record(), event: { id: 'good', title: 'kept' } },
        { ...record(), id: 'run-2', event: { id: 'bad' } },
        { ...record(), id: 'run-3', event: undefined },
      ],
    }
    await writeFile(path, JSON.stringify(file), 'utf8')
    const store = createRunStore<Event>({ path, parseEvent })
    await store.load()
    expect(store.list().map(run => run.id)).toEqual(['run-1'])
  })

  it('starts empty when the file is unreadable instead of throwing', async () => {
    const home = await scratch()
    const path = join(home, 'runs.json')
    await writeFile(path, '{ broken', 'utf8')
    const store = createRunStore<Event>({ path, parseEvent })
    await store.load()
    expect(store.list()).toEqual([])
  })
})
