/**
 * The bridge between the board and the harness's own services.
 *
 * None of this is exercised by a real harness in the unit suite, so the fakes
 * here encode the **contract** the runner relies on: a session is created, the
 * workspace is attached before the first message, the title is cosmetic, the run
 * settles on `turn/end`, and `stop` settles it too. When the real service names
 * are wired (see `docs/workbench-session-api.md`) these fakes are what proves the
 * wiring kept the same promises.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/harness-session
 */

import { describe, expect, it } from 'vitest'
import {
  createHarnessRunner,
  type LiveAgentLike,
  type SessionControllerLike,
  type SessionEventLike,
} from '../../src/workbench/harness-session.ts'

/** A controller that records what it was asked, and resolves to a stub agent. */
function controller(options: { rename?: boolean; archive?: boolean; failResolve?: boolean } = {}) {
  const calls = {
    created: [] as { cwd: string; agentPreset?: string }[],
    renamed: [] as { sessionId: string; title: string }[],
    archived: [] as string[],
    followed: [] as { role: string; text: string }[],
  }
  const agent: LiveAgentLike = {
    followup: (message) => {
      calls.followed.push({ role: message.role, text: message.content[0]?.text ?? '' })
      return undefined
    },
  }
  const value: SessionControllerLike = {
    create: async (request) => {
      calls.created.push(request)
      return { sessionId: 'session-1' }
    },
    resolveAgent: async () => (options.failResolve === true ? { error: new Error('no agent') } : { agent }),
    ...(options.rename === false ? {} : {
      rename: async (request) => {
        calls.renamed.push({ sessionId: request.sessionId, title: request.title })
      },
    }),
    ...(options.archive === false ? {} : {
      archive: async (sessionId) => {
        calls.archived.push(sessionId)
      },
    }),
  }
  return { calls, controller: value }
}

/** A workspace registry that records the attach. */
function workspaces(fail = false) {
  const calls = { created: [] as string[], attached: [] as string[] }
  return {
    calls,
    value: {
      create: async (cwd: string) => {
        calls.created.push(cwd)
        if (fail) throw new Error('no workspace')
        return { attachSession: async (sessionId: string) => { calls.attached.push(sessionId) } }
      },
    },
  }
}

/** Event subscribers the test drives by hand. */
function events() {
  const listeners: ((session: { id?: string }, event: SessionEventLike) => void)[] = []
  return {
    listeners,
    subscribe: (listener: (session: { id?: string }, event: SessionEventLike) => void): (() => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit: (sessionId: string, type: string): void => {
      for (const listener of [...listeners]) listener({ id: sessionId }, { type })
    },
  }
}

describe('createHarnessRunner', () => {
  it('answers undefined when there is nowhere to run', () => {
    expect(createHarnessRunner({ ...controller(), cwd: '', subscribe: events().subscribe, log: () => undefined }))
      .toBeUndefined()
  })

  it('creates the session, attaches the workspace, renames it, and sends the prompt', async () => {
    const { calls, controller: port } = controller()
    const workspace = workspaces()
    const stream = events()
    const runner = createHarnessRunner({
      controller: port,
      workspaces: workspace.value,
      cwd: 'C:/tmp/run',
      subscribe: stream.subscribe,
      log: () => undefined,
    })
    expect(runner).toBeDefined()
    const run = await runner?.start({ title: '页面报错', prompt: '修一下' })
    expect(calls.created).toEqual([{ cwd: 'C:/tmp/run' }])
    expect(workspace.calls.created).toEqual(['C:/tmp/run'])
    expect(workspace.calls.attached).toEqual(['session-1'])
    expect(calls.renamed).toEqual([{ sessionId: 'session-1', title: '页面报错' }])
    expect(calls.followed).toEqual([{ role: 'user', text: '修一下' }])
    expect(run?.sessionId).toBe('session-1')
  })

  it('settles on that session\'s turn end, and ignores other sessions', async () => {
    const { controller: port } = controller()
    const stream = events()
    const runner = createHarnessRunner({ controller: port, cwd: 'C:/tmp/run', subscribe: stream.subscribe, log: () => undefined })
    const run = await runner?.start({ title: 'x', prompt: 'y' })
    if (run === undefined) return
    const settled = run.finished.then((status) => status)
    stream.emit('other-session', 'turn/end')
    stream.emit('session-1', 'turn/start')
    stream.emit('session-1', 'turn/end')
    await expect(settled).resolves.toBe('done')
  })

  it('settles when the run is stopped, and archives the session', async () => {
    const { calls, controller: port } = controller()
    const runner = createHarnessRunner({ controller: port, cwd: 'C:/tmp/run', subscribe: events().subscribe, log: () => undefined })
    const run = await runner?.start({ title: 'x', prompt: 'y' })
    if (run === undefined) return
    const settled = run.finished
    run.stop()
    await expect(settled).resolves.toBe('failed')
    expect(calls.archived).toEqual(['session-1'])
  })

  it('keeps going when the workspace cannot be attached', async () => {
    // 挂工作区失败不该让整次运行作废：卡片已经在跑了，宁可少一层目录归属。
    const { controller: port } = controller()
    const lines: string[] = []
    const runner = createHarnessRunner({
      controller: port,
      workspaces: workspaces(true).value,
      cwd: 'C:/tmp/run',
      subscribe: events().subscribe,
      log: (line) => lines.push(line),
    })
    const run = await runner?.start({ title: 'x', prompt: 'y' })
    expect(run?.sessionId).toBe('session-1')
    expect(lines.join('\n')).toContain('failed')
  })

  it('fails the start when the session cannot be resolved to an agent', async () => {
    const { calls, controller: port } = controller({ failResolve: true })
    const runner = createHarnessRunner({ controller: port, cwd: 'C:/tmp/run', subscribe: events().subscribe, log: () => undefined })
    await expect(runner?.start({ title: 'x', prompt: 'y' })).rejects.toThrow('session-1')
    // 建了会话却没能跑起来，就不留一条空会话。
    expect(calls.archived).toEqual(['session-1'])
  })

  it('sends a follow-up into a live session', async () => {
    const { calls, controller: port } = controller()
    const runner = createHarnessRunner({ controller: port, cwd: 'C:/tmp/run', subscribe: events().subscribe, log: () => undefined })
    await runner?.send('session-1', '先看首页路由')
    expect(calls.followed).toEqual([{ role: 'user', text: '先看首页路由' }])
  })
})
