/**
 * 条目契约：从「一次性通知」升级成「能被处理的东西」。
 *
 * 这一组用例钉住的是**升级的意义**：条目有身份、有状态、有动作，而且点击会被路由回
 * 举起它的那个插件。三点最容易写错、也最容易让人对工作台失去信任：
 *
 * 1. **动作失败时条目必须留在队列里**——否则界面告诉用户「处理了」，而实际没有。
 * 2. **举起的插件没加载时，点击被拒绝并说明**，而不是静默吞掉。
 * 3. **`awaiting` 由 Host 算**，被 snooze 的条目不算待处理。
 *
 * @module @free-lzj/dsh-console/tests/items
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleHost, LOG_LIMIT } from '../src/console-host.ts'

/** 一个测试创建的临时目录，用完删掉。 */
const homes: string[] = []

afterEach(async () => {
  for (const directory of homes.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * 造一个 Host。
 * @returns Host 与它的临时目录。
 */
async function bench(): Promise<ConsoleHost> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-console-items-'))
  homes.push(directory)
  return new ConsoleHost(new Context(), {
    homeDir: directory,
    // 用一个不上报任何渠道的选择：这一组关心的是条目，不是投递。
    channels: () => [],
    layout: () => 'grid',
  })
}

describe('raise：比 notify 多的那两样东西', () => {
  it('保留 kind、actions 与 sessionId，状态是 new', async () => {
    const host = await bench()
    const record = await host.raise({
      title: '邮件分诊：限时优惠',
      kind: 'mail',
      actions: [{ id: 'apply', label: '执行' }, { id: 'ignore', label: '忽略', style: 'danger' }],
      sessionId: 'session-1',
    })
    expect(record.state).toBe('new')
    expect(record.kind).toBe('mail')
    expect(record.actions?.map(action => action.id)).toEqual(['apply', 'ignore'])
    expect(record.sessionId).toBe('session-1')
  })

  it('counts one session once, however many items it raised', async () => {
    // 状态条的「往你待办」是**件事**的数量：同一条会话既举了通知又在等回答，只算一件。
    const host = await bench()
    await host.raise({ title: '邮件分诊：限时优惠', kind: 'mail', sessionId: 'session-1' })
    await host.raise({ title: '邮件分诊：等你确认', kind: 'mail', sessionId: 'session-1' })
    await host.raise({ title: '没有会话的纯提醒' })
    expect(host.state().awaiting).toBe(2)
  })
  it('没有动作时是一个纯通知，字段不会被补成空数组', async () => {
    const host = await bench()
    const record = await host.raise({ title: '新邮件' })
    expect(record.actions).toBeUndefined()
    expect(record.state).toBe('new')
  })

  it('notify 仍然可用，并且和 raise 落进同一个列表', async () => {
    const host = await bench()
    await host.notify({ title: '来自旧调用方的通知' })
    await host.raise({ title: '条目', kind: 'mail', actions: [{ id: 'a', label: 'A' }] })
    expect(host.state().notices.map(record => record.title)).toEqual(['条目', '来自旧调用方的通知'])
  })

  it('写歪的动作被丢掉，不让一个没有 id 的按钮出现在界面上', async () => {
    const host = await bench()
    const record = await host.raise({
      title: 'x',
      kind: 'mail',
      actions: [{ id: '', label: '坏' }, { id: 'ok', label: '好' }],
    })
    expect(record.actions?.map(action => action.id)).toEqual(['ok'])
  })
})

describe('actOn：点击被路由回举起它的插件', () => {
  it('调对应的处理器，成功后标成 resolved 并记下选了哪个动作', async () => {
    const host = await bench()
    const handler = vi.fn(async () => { /* 干完了 */ })
    host.onAction('mail', handler)
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'apply', label: '执行' }] })

    expect(await host.actOn(record.id, 'apply')).toEqual({ ok: true })
    expect(handler).toHaveBeenCalledOnce()
    expect(host.state().notices[0]?.state).toBe('resolved')
    expect(host.state().notices[0]?.resolvedAction).toBe('apply')
  })

  it('处理器抛错时条目留在队列里，并带回原因', async () => {
    const host = await bench()
    host.onAction('mail', () => { throw new Error('工作台没装') })
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'apply', label: '执行' }] })

    expect(await host.actOn(record.id, 'apply')).toEqual({ ok: false, message: '工作台没装' })
    // 关键：没有被标成 resolved。
    expect(host.state().notices[0]?.state).toBe('new')
    expect(host.state().awaiting).toBe(1)
  })

  it('插件没加载时说清「没有加载」，而不是静默', async () => {
    const host = await bench()
    const record = await host.raise({ title: 'x', kind: 'gone', actions: [{ id: 'apply', label: '执行' }] })
    const result = await host.actOn(record.id, 'apply')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('gone')
  })

  it('条目不存在或动作不存在时都拒绝', async () => {
    const host = await bench()
    expect((await host.actOn('nope', 'apply')).ok).toBe(false)
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'apply', label: '执行' }] })
    expect((await host.actOn(record.id, 'other')).ok).toBe(false)
  })

  it('注册同一个 kind 两次时后者生效，旧的不再被调用', async () => {
    const host = await bench()
    const first = vi.fn()
    const second = vi.fn()
    host.onAction('mail', first)
    host.onAction('mail', second)
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'apply', label: '执行' }] })
    await host.actOn(record.id, 'apply')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('注销之后点击被拒绝——插件卸载了就不该还能点', async () => {
    const host = await bench()
    const dispose = host.onAction('mail', () => undefined)
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'apply', label: '执行' }] })
    dispose()
    expect((await host.actOn(record.id, 'apply')).ok).toBe(false)
  })
})

describe('正在跑的会话：让「它现在在替我干什么」可见', () => {
  it('读到的运行中会话出现在状态里，内容没变时 revision 不动', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-console-running-'))
    homes.push(directory)
    const read = vi.fn(async () => [{ sessionId: 's-1', title: 'GitHub：Run failed', cwd: 'D:/open/repo' }])
    const host = new ConsoleHost(new Context(), {
      homeDir: directory,
      channels: () => [],
      layout: () => 'grid',
      runningSessions: read,
      runningRefreshMs: 5,
    })
    await host.ready
    // 构造时就触发了一次读，等它落地。
    await vi.waitFor(() => { expect(host.state().running).toHaveLength(1) })
    const settled = host.state().revision
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(host.state().running[0]?.title).toBe('GitHub：Run failed')
    // 同一份内容再读几次不该 bump——否则页面每 5 秒重绘整个列表。
    expect(host.state().revision).toBe(settled)
    expect(read.mock.calls.length).toBeGreaterThan(1)
  })

  it('没接会话服务时就是空列表，而不是起不来', async () => {
    const host = await bench()
    expect(host.state().running).toEqual([])
  })

  it('会话服务抛错时只少一块，其他照常', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-console-running-fail-'))
    homes.push(directory)
    const host = new ConsoleHost(new Context(), {
      homeDir: directory,
      channels: () => [],
      layout: () => 'grid',
      runningSessions: async () => { throw new Error('会话服务挂了') },
      runningRefreshMs: 5,
    })
    await host.notify({ title: '条目照常' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(host.state().running).toEqual([])
    expect(host.state().notices).toHaveLength(1)
  })
})

describe('自动化日志：它做过的事不进队列', () => {
  it('记一条日志，但**不算**待处理', async () => {
    const host = await bench()
    host.log({ source: 'mail', title: '按「推广」处理了：限时优惠', detail: '已标记为已读；已移动到「推广」' })
    expect(host.state().log).toHaveLength(1)
    expect(host.state().log[0]?.ok).toBe(true)
    // 关键：一天归档二十封推广，队列里不该多出二十条。
    expect(host.state().awaiting).toBe(0)
    expect(host.state().notices).toHaveLength(0)
  })

  it('失败记成 ok:false——日志不能读起来像成功', async () => {
    const host = await bench()
    host.log({ source: 'mail', title: '归档失败', ok: false })
    expect(host.state().log[0]?.ok).toBe(false)
  })

  it('空标题被忽略，不产生一条没有意义的记录', async () => {
    const host = await bench()
    host.log({ source: 'mail', title: '   ' })
    expect(host.state().log).toHaveLength(0)
  })

  it('长度封顶，最新的在前', async () => {
    const host = await bench()
    for (let index = 0; index < LOG_LIMIT + 5; index += 1) {
      host.log({ source: 'mail', title: `第 ${String(index)} 条` })
    }
    expect(host.state().log).toHaveLength(LOG_LIMIT)
    expect(host.state().log[0]?.title).toBe(`第 ${String(LOG_LIMIT + 4)} 条`)
  })
})

describe('dismiss / snooze / awaiting', () => {
  it('dismiss 标成 dismissed 且不再计入待处理', async () => {
    const host = await bench()
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'a', label: 'A' }] })
    expect(host.state().awaiting).toBe(1)
    expect(host.dismiss(record.id)).toEqual({ ok: true })
    expect(host.state().notices[0]?.state).toBe('dismissed')
    expect(host.state().awaiting).toBe(0)
  })

  it('snooze 到将来才生效，过去的时刻被拒绝', async () => {
    const host = await bench()
    const record = await host.raise({ title: 'x' })
    expect(host.snooze(record.id, Date.now() - 1000).ok).toBe(false)
    expect(host.snooze(record.id, Date.now() + 60_000)).toEqual({ ok: true })
    // 被 snooze 的不算「现在要处理」。
    expect(host.state().awaiting).toBe(0)
  })

  it('一条通知也算待处理——它同样占着人的注意力', async () => {
    const host = await bench()
    await host.notify({ title: '只是告诉你一声' })
    expect(host.state().awaiting).toBe(1)
  })

  it('已经 resolved 的不再计入', async () => {
    const host = await bench()
    host.onAction('mail', () => undefined)
    const record = await host.raise({ title: 'x', kind: 'mail', actions: [{ id: 'a', label: 'A' }] })
    await host.actOn(record.id, 'a')
    expect(host.state().awaiting).toBe(0)
  })
})
