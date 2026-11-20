/**
 * DSH 连接器：会话两模式、工作区登记、触发器与词表。
 *
 * 用假的宿主服务驱动——这一侧唯一的领域知识就是「宿主有哪些服务」，把这部分假掉，
 * 剩下的全是可断言的逻辑。
 *
 * @module @free-lzj/dsh-connector-dsh/tests
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskContext } from '@free-lzj/dsh-decision'
import { followupAction, sessionAction } from '../src/actions/session.ts'
import { createDshConnector, normalizeDshAction, toolTrigger } from '../src/connector.ts'
import { createDshSessionPort } from '../src/ports.ts'

/** 一个只认 `get` 的上下文。 */
function contextOf(services: Map<string, unknown>): never {
  return {
    get: (name: string) => services.get(name),
    logger: { info: () => undefined, warn: () => undefined },
  } as never
}

/** 一个记账的会话服务。 */
function controller(calls: string[]): Map<string, unknown> {
  return new Map([['sessionController', {
    async create(request: { cwd: string }) {
      calls.push(`create:${request.cwd}`)
      return { sessionId: 'session-1' }
    },
    async resolveAgent(sessionId: string) {
      calls.push(`resolve:${sessionId}`)
      return {
        agent: {
          session: { id: sessionId },
          followup(message: unknown) {
            calls.push(`followup:${JSON.stringify(message)}`)
          },
        },
      }
    },
    async rename(request: { sessionId: string; title: string }) {
      calls.push(`rename:${request.title}`)
    },
  }]])
}

/** 一个记账的工作区表。 */
function registry(calls: string[], existing: boolean): Map<string, unknown> {
  const workspace = {
    title: 'existing',
    async attachSession(sessionId: string) {
      calls.push(`attach:${sessionId}`)
    },
  }
  return new Map([['workspaceRegistry', {
    async resolveByPath(path: string) {
      calls.push(`resolve:${path}`)
      return existing ? workspace : undefined
    },
    async create(path: string) {
      calls.push(`workspace:${path}`)
      return workspace
    },
  }]])
}

/** 一个最小的动作上下文。 */
function taskContext(input: {
  readonly ports: Readonly<Record<string, unknown>>
  readonly vars?: Readonly<Record<string, string>>
  readonly signal?: Readonly<Record<string, unknown>>
}): TaskContext {
  return {
    task: {
      id: 'task-1',
      connector: 'dsh',
      triggerId: 'console:tool',
      key: 'k',
      title: 't',
      at: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
      status: 'running',
      nodes: [],
      event: { type: 'console.tool.invoked', source: 'dsh', payload: {} },
      vars: {},
    },
    event: { type: 'console.tool.invoked', source: 'dsh', payload: {} },
    vars: input.vars ?? {},
    node: { id: 'node-1', kind: 'session' },
    ports: input.ports,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    now: new Date('2026-11-10T00:00:00.000Z'),
    log: () => undefined,
  }
}

describe('会话端口：工作区登记', () => {
  it('已有工作区就复用，不新建', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const services = controller(calls)
    for (const [name, service] of registry(calls, true)) services.set(name, service)
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await port.attachSession(cwd, 'session-1')
    expect(calls).toContain(`resolve:${cwd}`)
    expect(calls).toContain('attach:session-1')
    expect(calls.some(call => call.startsWith('workspace:'))).toBe(false)
  })

  it('没有工作区就按目录建一个，再挂会话', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const services = controller(calls)
    for (const [name, service] of registry(calls, false)) services.set(name, service)
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await port.attachSession(cwd, 'session-2')
    expect(calls).toContain(`workspace:${cwd}`)
    expect(calls).toContain('attach:session-2')
  })

  it('没有工作区表时安静跳过', async () => {
    const calls: string[] = []
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    await expect(port.attachSession('/tmp/none', 'session-3')).resolves.toBeUndefined()
  })

  it('工作区登记失败只记日志，不把动作搞崩', async () => {
    const lines: string[] = []
    const services = new Map<string, unknown>([['workspaceRegistry', {
      async resolveByPath() { throw new Error('目录不存在') },
      async create() { throw new Error('目录不存在') },
    }]])
    const port = createDshSessionPort(contextOf(services), line => { lines.push(line) })
    await expect(port.attachSession('/tmp/none', 'session-4')).resolves.toBeUndefined()
    expect(lines.join('\n')).toContain('没能登记到工作区')
  })

  it('没有会话服务时如实失败', async () => {
    const port = createDshSessionPort(contextOf(new Map()), () => undefined)
    await expect(port.createSession({ cwd: '/tmp/x' })).rejects.toThrow('没有会话服务')
  })
})

describe('session 动作', () => {
  it('建会话、登记工作区、改名、投递，并带回 sessionId', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const services = controller(calls)
    for (const [name, service] of registry(calls, true)) services.set(name, service)
    const port = createDshSessionPort(contextOf(services), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd },
      taskContext({ ports: { sessions: port }, vars: { prompt: '干活', rule: '规则', subject: '主题' } }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(outcome.data).toMatchObject({ scope: 'workspace', mode: 'create' })
    expect(calls).toContain(`create:${cwd}`)
    expect(calls).toContain('attach:session-1')
  })

  it('缺 workspace 是配置错，不建会话', async () => {
    const calls: string[] = []
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run({ kind: 'session' }, taskContext({ ports: { sessions: port } }))
    expect(outcome).toMatchObject({ ok: false, failure: 'config' })
    expect(calls).toEqual([])
  })

  it('默认等会话跑完：挂起说明带令牌、恢复载荷与到期时间', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd, instructions: '干活' },
      taskContext({ ports: { sessions: port } }),
    )
    expect(outcome.wait).toMatchObject({
      on: 'event',
      token: 'session:session-1',
      resume: { sessionId: 'session-1' },
    })
    // 上下文里的 now 是 2026-11-10T00:00:00Z，默认等 240 分钟。
    expect(outcome.wait?.dueAt).toBe('2026-11-10T04:00:00.000Z')
    // 挂起说明要能认出是哪个会话：截头 8 位只剩 `session-`，看板上所有等待都长一样。
    expect(outcome.wait?.detail).toBe('等会话 session-1 干完')
  })

  it('写了 awaitSession: none 就发完即走', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd, awaitSession: 'none', instructions: '干活' },
      taskContext({ ports: { sessions: port } }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(outcome.wait).toBeUndefined()
  })

  it('续跑时认出自己的令牌：不再建第二个会话', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd },
      taskContext({
        ports: { sessions: port },
        signal: { sessionId: 'session-1', token: 'session:session-1' },
      }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(outcome.wait).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('别的信号不让它跳过建会话', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd, instructions: '干活' },
      taskContext({
        ports: { sessions: port },
        signal: { ticket: 'T1', token: '票:T1:1' },
      }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(calls).toContain(`create:${cwd}`)
  })

  it('模板里有没配的变量就失败，不去建一个错的目录', async () => {
    const calls: string[] = []
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspaceTemplate: '{repoRoot}/{repo}' },
      taskContext({ ports: { sessions: port }, vars: { repoRoot: 'D:/x' } }),
    )
    expect(outcome).toMatchObject({ ok: false, failure: 'config' })
    expect(calls).toEqual([])
  })

  it('自己没写正文时走连接器的 prompt 端口渲染（邮件就是这样把正文交给会话的）', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    let rendered = 0
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd, awaitSession: 'none' },
      taskContext({
        ports: {
          sessions: port,
          prompt: {
            async render() {
              rendered += 1
              return '渲染好的正文'
            },
          },
        },
      }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(rendered).toBe(1)
    expect(calls.some(call => call.includes('渲染好的正文'))).toBe(true)
  })

  it('三个来源都没有正文就判配置错，绝不建一个收空消息的会话', async () => {
    const calls: string[] = []
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-'))
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await sessionAction.run(
      { kind: 'session', workspace: cwd },
      taskContext({ ports: { sessions: port } }),
    )
    expect(outcome).toMatchObject({ ok: false, failure: 'config' })
    expect(calls).toEqual([])
  })
})

describe('会话端口：探视完成状态', () => {
  /** 一个能报状态的会话服务；`status` 传 undefined 就是「宿主不报」。 */
  function states(status: 'idle' | 'running' | undefined, calls: string[] = []): Map<string, unknown> {
    return new Map([['sessionController', {
      async create() {
        calls.push('create')
        return { sessionId: 'session-1' }
      },
      async resolveAgent(sessionId: string) {
        return {
          agent: {
            session: { id: sessionId },
            ...(status === undefined ? {} : { status }),
            followup() {},
          },
        }
      },
    }]])
  }

  it('还在跑就继续等', async () => {
    const port = createDshSessionPort(contextOf(states('running')), () => undefined)
    await expect(port.probe('session-9')).resolves.toMatchObject({ ready: false, status: 'running' })
  })

  it('见过它跑之后再看到 idle 才算干完', async () => {
    // 宿主给的是同一个 agent 对象，状态在它身上变——端口缓存的是这个对象，不是快照。
    const agent: { session: { id: string }; status: 'idle' | 'running'; followup(): void } = {
      session: { id: 'session-9' },
      status: 'running',
      followup() {},
    }
    const services = new Map([['sessionController', {
      async resolveAgent() {
        return { agent }
      },
    }]])
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await expect(port.probe('session-9')).resolves.toMatchObject({ ready: false })
    agent.status = 'idle'
    await expect(port.probe('session-9')).resolves.toMatchObject({ ready: true, status: 'idle' })
  })

  it('刚建好也是 idle，不能当成已经干完', async () => {
    const calls: string[] = []
    const services = states('idle', calls)
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await port.createSession({ cwd: mkdtempSync(join(tmpdir(), 'dsh-probe-')) })
    await expect(port.probe('session-1')).resolves.toMatchObject({ ready: false })
  })

  it('宿主不报状态时按时间宽限，刚建的不放行', async () => {
    const services = states(undefined)
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await port.createSession({ cwd: mkdtempSync(join(tmpdir(), 'dsh-probe-')) })
    const verdict = await port.probe('session-1')
    expect(verdict.ready).toBe(false)
    expect(verdict.detail).toContain('宽限')
  })

  it('会话没了就是没了，别把链挂到超时', async () => {
    const services = new Map([['sessionController', {
      async resolveAgent() {
        return { error: 'gone' }
      },
    }]])
    const port = createDshSessionPort(contextOf(services), () => undefined)
    await expect(port.probe('session-gone')).resolves.toMatchObject({ ready: false, detail: '会话已经不在了' })
  })
})

describe('followup 动作', () => {
  it('投递到已有会话，节点标明是引用', async () => {
    const calls: string[] = []
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await followupAction.run(
      { kind: 'followup', sessionId: 'existing-1', prompt: '读这封' },
      taskContext({ ports: { sessions: port } }),
    )
    expect(outcome).toMatchObject({ ok: true, sessionId: 'existing-1' })
    expect(outcome.data).toMatchObject({ mode: 'followup', external: true })
  })

  it('缺 sessionId 就失败，绝不偷偷新建', async () => {
    const calls: string[] = []
    const port = createDshSessionPort(contextOf(controller(calls)), () => undefined)
    const outcome = await followupAction.run({ kind: 'followup', prompt: 'x' }, taskContext({ ports: { sessions: port } }))
    expect(outcome).toMatchObject({ ok: false, failure: 'config' })
    expect(calls.some(call => call.startsWith('create:'))).toBe(false)
  })
})

describe('console:tool 触发器与词表', () => {
  it('工具已经建好会话时，把 sessionId 交回核心', async () => {
    const outcome = await toolTrigger.run(
      { type: 'console.tool.invoked', source: 'console', payload: { title: 'Jira 派单', sessionId: 'session-9' } },
      { event: { type: 'console.tool.invoked', source: 'console', payload: {} }, ports: {}, now: new Date(), log: () => undefined },
    )
    expect(outcome).toMatchObject({ status: 'continue', sessionId: 'session-9' })
    expect(outcome.seed?.title).toBe('Jira 派单')
  })

  it('词表只认自己的七个动作，动作开关不再透传', () => {
    expect(normalizeDshAction({ kind: 'session', workspace: '/tmp/x', mode: 'suggest' }))
      .toMatchObject({ kind: 'session', workspace: '/tmp/x' })
    expect(normalizeDshAction({ kind: 'markRead' })).toBeUndefined()
    expect(normalizeDshAction({ kind: 'llm', model: 'deepseek/deepseek-chat', maxTokens: 256 }))
      .toMatchObject({ kind: 'llm', model: 'deepseek/deepseek-chat', maxTokens: 256 })
  })

  it('session 的等待开关只收认识的写法，歪值当没写', () => {
    expect(normalizeDshAction({ kind: 'session', awaitSession: 'idle', timeoutMinutes: 180 }))
      .toMatchObject({ awaitSession: 'idle', timeoutMinutes: 180 })
    expect(normalizeDshAction({ kind: 'session', awaitSession: 'none' }))
      .toMatchObject({ awaitSession: 'none' })
    // 写歪了就不带这两个键：默认值（等、240 分钟）由动作自己兜。
    const sloppy = normalizeDshAction({ kind: 'session', awaitSession: '什么时候好', timeoutMinutes: -5 })
    expect(sloppy).not.toHaveProperty('awaitSession')
    expect(sloppy).not.toHaveProperty('timeoutMinutes')
  })

  it('装配出来的连接器带着七个动作与一个触发器', () => {
    const connector = createDshConnector(contextOf(new Map()))
    expect(connector.id).toBe('dsh')
    expect(connector.triggers.map(trigger => trigger.id)).toEqual(['console:tool'])
    expect(connector.actions.map(action => action.kind).sort())
      .toEqual(['followup', 'http', 'llm', 'mcp', 'notify', 'script', 'session'])
    // 端口是惰性的：服务还没挂载时属性存在但值是 undefined，取的时候才解析。
    expect('llm' in connector.ports!).toBe(true)
  })
})
