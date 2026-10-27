/**
 * The bridge between the board and the harness's own services.
 *
 * None of this runs against a real harness in the unit suite, so the fakes here
 * encode the **contract**: `agents.createSession({cwd})` builds an agent and its
 * session, a prompt goes in through `agent.followup`, the run settles on that
 * session's `turn/end` (`completed` → done, anything else → failed), `stop`
 * cancels and settles, and a session this runner did not start cannot be talked
 * to. When the wiring changes, these are what proves the promises did not.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/harness-session
 */

import { describe, expect, it } from 'vitest'
import {
  createHarnessRunner,
  runningSessionsOf,
  type HarnessAgentLike,
  type HarnessAgentsLike,
  type HarnessSessionEventLike,
} from '../../src/workbench/harness-session.ts'

/** An agent stub that records what it was asked to do. */
function agent(sessionId = 'session-1') {
  const calls = { followed: [] as string[], cancelled: 0 }
  const value: HarnessAgentLike & { calls: typeof calls } = {
    calls,
    session: { id: sessionId, header: { cwd: 'C:/tmp/run' } },
    followup: (message) => {
      calls.followed.push(message.content[0]?.text ?? '')
      return undefined
    },
    cancel: () => {
      calls.cancelled += 1
    },
    isActive: () => true,
  }
  return value
}

/** An agent plus the calls it recorded. */
type RecordedAgent = HarnessAgentLike & { readonly calls: { followed: string[]; cancelled: number } }

/** The agents service, with one pre-made agent per call. */
function agents(options: { noSession?: boolean } = {}) {
  const created: RecordedAgent[] = []
  const value: HarnessAgentsLike = {
    createSession: async () => {
      const made = agent()
      // 模拟「建了代理但没有会话 id」。
      if (options.noSession === true) delete (made as { session?: unknown }).session
      created.push(made as unknown as RecordedAgent)
      return { agent: made }
    },
    list: () => created,
  }
  return { created, value }
}

/** Event subscribers the test drives by hand. */
function events() {
  const listeners: ((session: { readonly id?: string }, event: HarnessSessionEventLike) => void)[] = []
  return {
    listeners,
    subscribe: (
      listener: (session: { readonly id?: string }, event: HarnessSessionEventLike) => void,
    ): (() => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit: (sessionId: string, type: string, kind?: string): void => {
      const event = kind === undefined ? { type } : { type, data: { reason: { kind } } }
      for (const listener of [...listeners]) listener({ id: sessionId }, event)
    },
  }
}

/** A runner over the fakes. */
function runner(options: { noSession?: boolean; cwd?: string } = {}) {
  const stream = events()
  const service = agents(options)
  const lines: string[] = []
  const value = createHarnessRunner({
    agents: service.value,
    cwd: options.cwd ?? 'C:/tmp/run',
    subscribe: stream.subscribe,
    log: (line) => lines.push(line),
  })
  return { runner: value, stream, created: service.created, lines }
}

describe('createHarnessRunner', () => {
  it('answers undefined when there is nowhere to run', () => {
    expect(runner({ cwd: '' }).runner).toBeUndefined()
  })

  it('answers undefined, and says why, when the agents service cannot create sessions', () => {
    // `agents` 自己只有 create/resume；`createSession` 是 SessionController 插件加上去的。
    // 没有它时宁可注册不了执行器，也不要在派单那一刻抛一句 TypeError。
    const lines: string[] = []
    const value = createHarnessRunner({
      agents: { create: async () => ({ agent: agent() }) } as unknown as HarnessAgentsLike,
      cwd: 'C:/tmp/run',
      subscribe: events().subscribe,
      log: (line) => lines.push(line),
    })
    expect(value).toBeUndefined()
    expect(lines.join('\n')).toContain('createSession')
  })

  it('creates the agent and puts the prompt in', async () => {
    const { runner: port, created } = runner()
    const run = await port?.start({ title: '页面报错', prompt: '修一下' })
    expect(run?.sessionId).toBe('session-1')
    expect(created[0]?.calls.followed).toEqual(['修一下'])
  })

  it('settles done on a completed turn, and ignores other sessions', async () => {
    const { runner: port, stream } = runner()
    const run = await port?.start({ title: 'x', prompt: 'y' })
    if (run === undefined) return
    const settled = run.finished
    stream.emit('other-session', 'turn/end', 'completed')
    stream.emit('session-1', 'turn/start')
    stream.emit('session-1', 'turn/end', 'completed')
    await expect(settled).resolves.toBe('done')
  })

  it('settles failed on an errored turn', async () => {
    const { runner: port, stream } = runner()
    const run = await port?.start({ title: 'x', prompt: 'y' })
    if (run === undefined) return
    const settled = run.finished
    stream.emit('session-1', 'turn/end', 'error')
    await expect(settled).resolves.toBe('failed')
  })

  it('cancels the agent and settles when stopped', async () => {
    const { runner: port, created } = runner()
    const run = await port?.start({ title: 'x', prompt: 'y' })
    if (run === undefined) return
    const settled = run.finished
    run.stop()
    expect(created[0]?.calls.cancelled).toBe(1)
    await expect(settled).resolves.toBe('failed')
  })

  it('refuses a start whose agent reports no session id, and cancels it', async () => {
    const { runner: port, created } = runner({ noSession: true })
    await expect(port?.start({ title: 'x', prompt: 'y' })).rejects.toThrow('no session id')
    expect((created[0] as unknown as { calls: { cancelled: number } }).calls.cancelled).toBe(1)
  })

  it('sends a follow-up into a session it started', async () => {
    const { runner: port, created } = runner()
    await port?.start({ title: 'x', prompt: 'y' })
    await port?.send('session-1', '先看首页路由')
    expect(created[0]?.calls.followed).toEqual(['y', '先看首页路由'])
  })

  it('refuses a follow-up into a session it did not start', async () => {
    const { runner: port } = runner()
    await expect(port?.send('elsewhere', '喂')).rejects.toThrow('was not started here')
  })
})

describe('runningSessionsOf', () => {
  it('lists the agents that are driving a turn right now', () => {
    const active = agent('session-1')
    const idle: HarnessAgentLike = { session: { id: 'session-2' }, followup: () => undefined, isActive: () => false }
    expect(runningSessionsOf({ createSession: async () => ({ agent: active }), list: () => [active, idle] }))
      .toEqual([{ sessionId: 'session-1', cwd: 'C:/tmp/run' }])
  })

  it('answers nothing when the service is absent', () => {
    expect(runningSessionsOf(undefined)).toEqual([])
  })
})
