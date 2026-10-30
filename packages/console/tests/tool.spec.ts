/**
 * 两个 agent 工具的契约：它们出现在工具表里、真的调了工作台/会话服务，缺能力时
 * 说人话而不是半挂。
 *
 * 这一层不碰 cordis 的真实生命周期：`registerAgentTools` 只认 `ctx.get` 与 `ctx.logger`，
 * 所以一个假上下文就够（与 `mount.spec.ts` 用假 Context 的理由一样）。
 *
 * @module @free-lzj/dsh-console/tests/tool
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleHost } from '../src/console-host.ts'
import type { ConsoleNotice } from '../src/protocol.ts'
import { registerAgentTools } from '../src/tools.ts'

/** 每个测试自己拥有的目录，跑完删掉。 */
const dirs: string[] = []

afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** @returns 一个这条测试独占的临时目录。 */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-console-tool-'))
  dirs.push(directory)
  return directory
}

/** 一个已注册的工具形状：测试只关心名字、参数与执行。 */
interface RegisteredTool {
  readonly name: string
  readonly parameters: unknown
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

/**
 * 造一个假上下文、假工具注册表与假工作台。
 * @returns 注册表里收到的工具、工作台收到的通知，以及可替换的服务表。
 */
function bench(): {
  tools: RegisteredTool[]
  notices: ConsoleNotice[]
  services: Map<string, unknown>
  ctx: Context
  host: ConsoleHost
} {
  const tools: RegisteredTool[] = []
  const notices: ConsoleNotice[] = []
  const services = new Map<string, unknown>()
  const registry = {
    register(definition: unknown): () => void {
      tools.push(definition as RegisteredTool)
      return () => undefined
    },
  }
  services.set('tools', registry)
  const ctx = {
    get: (name: string) => services.get(name),
    logger: { info: () => undefined },
  } as unknown as Context
  const host = {
    async notify(notice: ConsoleNotice) {
      notices.push(notice)
      return { id: 'notice-1', createdAt: 0, delivered: [] }
    },
  } as unknown as ConsoleHost
  return { tools, notices, services, ctx, host }
}

describe('registerAgentTools', () => {
  it('没有工具注册表时安静地什么都不做', () => {
    const services = new Map<string, unknown>()
    const ctx = { get: (name: string) => services.get(name), logger: { info: () => undefined } } as unknown as Context
    const host = {} as ConsoleHost

    expect(() => registerAgentTools(ctx, host)).not.toThrow()
    expect(registerAgentTools(ctx, host)).toBeTypeOf('function')
  })

  it('注册两个工具，参数表按模型看得懂的 JSON Schema 编译', () => {
    const { tools, ctx, host } = bench()
    registerAgentTools(ctx, host)

    expect(tools.map(tool => tool.name)).toEqual(['console_notify', 'open_session'])
    const parameters = (tools[0] as RegisteredTool).parameters as {
      readonly type: string
      readonly required: readonly string[]
      readonly properties: Record<string, { readonly type?: string; readonly enum?: readonly string[] }>
    }
    expect(parameters.type).toBe('object')
    expect(Object.keys(parameters.properties)).toEqual(['title', 'body', 'tone'])
    expect(parameters.required).toEqual(['title'])
    expect(parameters.properties.tone?.enum).toEqual(['info', 'success', 'warn', 'error'])
  })
})

describe('console_notify', () => {
  it('把标题、正文与语气交给工作台', async () => {
    const { tools, notices, ctx, host } = bench()
    registerAgentTools(ctx, host)
    const notify = tools.find(tool => tool.name === 'console_notify') as RegisteredTool

    await notify.execute({ title: '分支已就绪', body: 'EXEPD-227893 等你确认后 push', tone: 'warn' })

    expect(notices).toEqual([
      { title: '分支已就绪', body: 'EXEPD-227893 等你确认后 push', tone: 'warn', source: 'agent' },
    ])
  })

  it('缺 title 时被参数校验挡住', async () => {
    const { tools, notices, ctx, host } = bench()
    registerAgentTools(ctx, host)
    const notify = tools.find(tool => tool.name === 'console_notify') as RegisteredTool

    await expect(notify.execute({ body: '没有标题' })).rejects.toThrow()
    expect(notices).toHaveLength(0)
  })
})

describe('open_session', () => {
  /** 造一套记账的会话端口（工作台提供），工具注册结果收进 `opened`。 */
  function sessionHost(calls: string[]): ConsoleHost {
    return {
      notify: async () => ({}),
      sessions: {
        async createSession(request: { readonly cwd: string; readonly agentPreset?: string }) {
          calls.push(`create:${request.cwd}:${request.agentPreset ?? ''}`)
          return { sessionId: 'session-9' }
        },
        async attachSession() {},
        async rename(sessionId: string, title: string) {
          calls.push(`rename:${sessionId}:${title}`)
        },
        setPermission() {},
        async followup(sessionId: string, text: string) {
          calls.push(`followup:${sessionId}:${text}`)
        },
      },
    } as unknown as ConsoleHost
  }

  /** 用一个服务表造上下文。 */
  function contextOf(services: Map<string, unknown>): Context {
    return {
      get: (name: string) => services.get(name),
      logger: { info: () => undefined, warn: () => undefined },
    } as unknown as Context
  }

  /** 只带工具注册表的上下文。 */
  function toolsOnly(opened: RegisteredTool[]): Map<string, unknown> {
    return new Map([['tools', {
      register: (definition: unknown) => { opened.push(definition as RegisteredTool); return () => undefined },
    }]])
  }

  /** 一个记账的工作区表：`create` 记一行，`attachSession` 记一行。 */
  function workspaceTable(calls: string[]): Map<string, unknown> {
    return new Map([['workspaceRegistry', {
      async create(path: string) {
        calls.push(`workspace:${path}`)
        return {
          title: 'EXEPD-229676',
          async attachSession(sessionId: string) {
            calls.push(`attach:${sessionId}`)
          },
        }
      },
    }]])
  }

  it('按「建工作区 → 建会话 → 挂工作区 → 起标题 → 投递」的顺序做完', async () => {
    const calls: string[] = []
    const opened: RegisteredTool[] = []
    const cwd = await tempDir()
    const services = toolsOnly(opened)
    for (const [name, service] of workspaceTable(calls)) services.set(name, service)
    registerAgentTools(contextOf(services), sessionHost(calls))

    const tool = opened.find(entry => entry.name === 'open_session') as RegisteredTool
    const value = await tool.execute({ cwd, title: 'Jira EXEPD-229676', prompt: '加载 skill jira-bugfix' })

    expect(value).toEqual({ sessionId: 'session-9', cwd, workspace: 'EXEPD-229676' })
    expect(calls).toEqual([
      `workspace:${cwd}`,
      `create:${cwd}:`,
      'attach:session-9',
      'rename:session-9:Jira EXEPD-229676',
      'followup:session-9:加载 skill jira-bugfix',
    ])
  })

  it('目录不存在时直接失败，不建半成品会话', async () => {
    const calls: string[] = []
    const opened: RegisteredTool[] = []
    const services = toolsOnly(opened)
    for (const [name, service] of workspaceTable(calls)) services.set(name, service)
    registerAgentTools(contextOf(services), sessionHost(calls))

    const tool = opened.find(entry => entry.name === 'open_session') as RegisteredTool
    await expect(tool.execute({ cwd: join(tmpdir(), 'dsh-console-missing-dir'), title: 'x', prompt: 'y' })).rejects.toThrow('工作目录不存在')
    expect(calls).toEqual([])
  })

  it('没有建会话能力时说清缺什么', async () => {
    const opened: RegisteredTool[] = []
    registerAgentTools(contextOf(toolsOnly(opened)), { notify: async () => ({}) } as unknown as ConsoleHost)

    const tool = opened.find(entry => entry.name === 'open_session') as RegisteredTool
    const cwd = await tempDir()
    await expect(tool.execute({ cwd, title: 'x', prompt: 'y' })).rejects.toThrow('没有提供建会话的能力')
  })

  it('没有工作区表时先失败，不建出掉进「未分组」的会话', async () => {
    const calls: string[] = []
    const opened: RegisteredTool[] = []
    const cwd = await tempDir()
    registerAgentTools(contextOf(toolsOnly(opened)), sessionHost(calls))

    const tool = opened.find(entry => entry.name === 'open_session') as RegisteredTool
    await expect(tool.execute({ cwd, title: 'x', prompt: 'y' })).rejects.toThrow('没有工作区表')
    expect(calls).toEqual([])
  })

  it('建工作区失败时也不建会话，错误照实抛出去', async () => {
    const calls: string[] = []
    const opened: RegisteredTool[] = []
    const cwd = await tempDir()
    const services = toolsOnly(opened)
    services.set('workspaceRegistry', {
      async create() {
        throw new Error('工作区表说这个目录不是目录')
      },
    })
    registerAgentTools(contextOf(services), sessionHost(calls))

    const tool = opened.find(entry => entry.name === 'open_session') as RegisteredTool
    await expect(tool.execute({ cwd, title: 'x', prompt: 'y' })).rejects.toThrow('不是目录')
    expect(calls).toEqual([])
  })
})
