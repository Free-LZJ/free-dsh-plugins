/**
 * The notification pipeline: what a notice does on its way out.
 *
 * The dispatcher is the one place where "which channels exist" (the registry),
 * "which are switched on" (the configuration) and "can this one deliver right
 * now" (`plan`) meet, so it is driven here without a browser: the page-facing
 * channels are stubbed through `PageSurfaces`, and the presence gate is a real
 * one.
 *
 * @module @free-lzj/dsh-console/tests/notify
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { PresenceGate, registerBuiltinChannels, type PageSurfaces } from '../src/builtin-channels.ts'
import type { NotificationChannel } from '../src/channels.ts'
import { ConsoleHost } from '../src/console-host.ts'

/** A page that records what it was asked to do. */
function page(): PageSurfaces & { raised: string[]; chimed: string[] } {
  const raised: string[] = []
  const chimed: string[] = []
  return {
    raised,
    chimed,
    raise: (delivery) => {
      raised.push(delivery.title)
      return Promise.resolve(true)
    },
    chime: (delivery) => {
      chimed.push(delivery.title)
      return true
    },
  }
}

/**
 * Build a host with the shipped channels and a scripted configuration.
 * @param channels - ids the configuration switches on.
 * @param openPage - whether a workbench page is streaming.
 * @returns the host, its page stub and its gate.
 */
function bench(channels: readonly string[] = ['desktop', 'inapp', 'sound'], openPage = true) {
  const ctx = new Context()
  const surfaces = page()
  const host = new ConsoleHost(ctx, {
    homeDir: '/nonexistent-dsh-home',
    channels: () => channels,
    layout: () => 'grid',
  })
  registerBuiltinChannels(host.channels, { gate: host.presence, pages: surfaces })
  if (openPage) host.presence.open()
  return { ctx, host, surfaces }
}

describe('notification dispatch', () => {
  it('offers a notice to every enabled channel and records which delivered', async () => {
    const { host, surfaces } = bench()
    const record = await host.notify({ title: '新邮件', body: '来自张三' })
    expect(record.title).toBe('新邮件')
    expect(record.tone).toBe('info')
    expect([...record.delivered].sort()).toEqual(['desktop', 'inapp', 'sound'])
    expect(surfaces.raised).toEqual(['新邮件'])
    expect(surfaces.chimed).toEqual(['新邮件'])
  })

  it('honours the configured subset', async () => {
    const { host, surfaces } = bench(['inapp'])
    const record = await host.notify({ title: '只进中心' })
    expect(record.delivered).toEqual(['inapp'])
    expect(surfaces.raised).toEqual([])
  })

  it('keeps a notice undelivered when no page is open to render it', async () => {
    const { host } = bench(['desktop', 'inapp'], false)
    const record = await host.notify({ title: '没人看' })
    expect(record.delivered).toEqual([])
  })

  it('never rejects because one channel failed, and keeps the notice', async () => {
    const { host } = bench(['desktop', 'inapp'])
    const broken: NotificationChannel = {
      id: 'broken',
      plan: () => true,
      deliver: () => Promise.reject(new Error('no route to the user')),
    }
    host.channels.register(broken)
    const record = await host.notify({ title: '照常记录', tone: 'warn' })
    expect(record.title).toBe('照常记录')
    expect(record.delivered).toEqual(['desktop', 'inapp'])
  })

  it('refuses a notice with no title rather than sending an empty one', async () => {
    const { host } = bench()
    await expect(host.notify({ title: '   ' })).rejects.toThrow(TypeError)
  })

  it('drops the oldest notices past the cap', async () => {
    const { host } = bench(['inapp'])
    for (let index = 0; index < 60; index += 1) await host.notify({ title: `第 ${index} 条` })
    const state = host.state()
    expect(state.notices).toHaveLength(50)
    expect(state.notices[0]?.title).toBe('第 59 条')
  })
})

describe('registration is a strategy set, not a switch', () => {
  it('rejects a duplicate channel id instead of letting two answer one name', () => {
    const { host } = bench()
    const duplicate: NotificationChannel = { id: 'desktop', plan: () => false, deliver: () => Promise.resolve(false) }
    expect(() => host.channels.register(duplicate)).toThrow(/already registered/)
  })

  it('lets a channel decide for itself with plan()', async () => {
    const { host } = bench(['inapp', 'picky'])
    const picky: NotificationChannel = {
      id: 'picky',
      plan: (delivery) => delivery.tone === 'error',
      deliver: vi.fn(() => Promise.resolve(true)),
    }
    host.channels.register(picky)
    const quiet = await host.notify({ title: '例行' })
    expect(quiet.delivered).toEqual(['inapp'])
    const loud = await host.notify({ title: '出事', tone: 'error' })
    expect(loud.delivered).toEqual(['inapp', 'picky'])
    expect(picky.deliver).toHaveBeenCalledTimes(1)
  })

  it('delivers in the order the saved selection lists', async () => {
    const { host } = bench(['sound', 'inapp', 'desktop'])
    const record = await host.notify({ title: '顺序' })
    expect(record.delivered).toEqual(['sound', 'inapp', 'desktop'])
  })

  it('never delivers a channel the selection leaves out, even when it is registered', async () => {
    const { host } = bench(['desktop'])
    const observer: NotificationChannel = { id: 'observer', plan: () => true, deliver: vi.fn(() => Promise.resolve(true)) }
    host.channels.register(observer)
    const record = await host.notify({ title: '只该有一条' })
    expect(record.delivered).toEqual(['desktop'])
    expect(observer.deliver).not.toHaveBeenCalled()
  })
})

describe('presence gate', () => {
  it('counts readers and closes idempotently', () => {
    const gate = new PresenceGate()
    expect(gate.live).toBe(false)
    const close = gate.open()
    expect(gate.live).toBe(true)
    close()
    close()
    expect(gate.live).toBe(false)
  })
})