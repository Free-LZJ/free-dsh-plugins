/**
 * Agent 可调用的两个工具：告诉你一件事、在某个目录里开一个会话。
 *
 * 为什么住在工作台：前者正是 `ctx.console` 的门面（通知中心 + 桌面通知），后者用的是
 * 首页已经在读的 `sessionController`/`workspaceRegistry`。放进邮件插件会让「没装邮箱」
 * 变成「没有通知工具」，新开一个包又要为一个四十行的注册再养一套构建。
 *
 * 三个宿主服务（`tools` / `sessionController` / `workspaceRegistry`）都是**可选**的：
 * 缺了就少一个能力，绝不半挂（`rules/design-patterns.md`）。所以工具在注册那一刻探测
 * 工具注册表，两个工具的 `execute` 再各自探测自己要用的服务，缺了返回一句人话。
 *
 * @module @free-lzj/dsh-console/tools
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConsoleHost } from './console-host.ts'
import type { NoticeTone } from './protocol.ts'

/** 工具注册表里本模块用得到的那部分；注册返回一个注销函数。 */
interface ToolRuntimeLike {
  register(definition: unknown): () => void
}

/**
 * 会话服务里本模块用得到的那部分。
 *
 * 与 `packages/mail/src/triage/actions/session.ts` 走的是同一串动词、同一个顺序：先建
 * 会话、再把它挂到工作区、然后改名，最后才投递第一条消息。这里不共用代码是因为两边
 * 都不该为了「同一段十行」再引一个包。
 */
interface SessionControllerLike {
  create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<
    | { readonly agent: { followup(message: unknown): void } }
    | { readonly error: unknown }
  >
}

/** 工作区服务里本模块用得到的那部分。 */
interface WorkspaceRegistryLike {
  create(path: string): Promise<{ attachSession(id: string): Promise<void> }>
}

/** 一条通知的语气；入参用字符串，落下时收窄。 */
const TONES: readonly NoticeTone[] = ['info', 'success', 'warn', 'error']

/**
 * 注册两个工具；没有工具注册表时什么都不做。
 * @param ctx - Host 上下文。
 * @param host - 工作台服务（通知的门面）。
 * @returns 注销函数，交给调用方的 `ctx.effect`。
 */
export function registerAgentTools(ctx: Context, host: ConsoleHost): () => void {
  const tools = ctx.get('tools') as ToolRuntimeLike | undefined
  if (tools?.register === undefined) {
    ctx.logger.info('console: 没有工具注册表，agent 工具未注册')
    return () => undefined
  }

  const notifyTool = defineTool({
    name: 'console_notify',
    description:
      '给你发一条工作台通知（桌面通知 + 通知中心 + 提示音）。用于「需要你知道、但不需要你立刻回答」的节点，例如推送前、长任务跑完。不阻塞、不等待回答；需要人做决定时仍然要在对话里问。',
    parameters: {
      title: { type: 'string', required: true, description: '一行标题，说清是什么事' },
      body: { type: 'string', description: '补充一句：在哪、做了什么、下一步是什么' },
      tone: {
        type: 'string',
        enum: TONES,
        description: '语气：info（默认）/ success / warn / error',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, title: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `已通知：${value.title}` : '通知未能送出' }],
    },
    async execute(args) {
      await host.notify({
        title: args.title,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.tone === undefined ? {} : { tone: args.tone }),
        source: 'agent',
      })
      return { ok: true, title: args.title }
    },
  })

  const openSessionTool = defineTool({
    name: 'open_session',
    description:
      '在一个已存在的工作目录里新建 DSH 工作区，并在其中开一个会话，把 prompt 作为它的第一条消息投递进去。用于「活要落在某个具体仓库里干」的场面（例如派单后到项目目录里开工）。目录必须已经存在，本工具不建目录。',
    parameters: {
      cwd: { type: 'string', required: true, description: '绝对路径，且必须是已存在的目录（通常是一个仓库）' },
      title: { type: 'string', required: true, description: '会话标题，一眼能看出这是哪件事' },
      prompt: { type: 'string', required: true, description: '投递给新会话的第一条消息' },
      agentPreset: { type: 'string', description: '可选的 agent 预设 id；不给就用部署默认' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, cwd: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `已在 ${value.cwd} 新建会话 ${value.sessionId}` }],
    },
    async execute(args) {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      const workspaces = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (controller === undefined || workspaces === undefined) {
        throw new Error('未挂载会话服务（sessionController / workspaceRegistry），无法新建会话')
      }
      if (!isAbsolute(args.cwd)) throw new Error(`工作目录必须是绝对路径：${args.cwd}`)
      assertDirectory(args.cwd)

      const created = await controller.create({
        cwd: args.cwd,
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
      })
      // 顺序不能换：会话先存在，工作区才有东西可挂；而第一条消息必须在挂好之后投递，
      // 否则它落在哪个工作区取决于宿主此刻怎么想。
      const workspace = await workspaces.create(args.cwd)
      await workspace.attachSession(created.sessionId)
      await controller.rename?.({ sessionId: created.sessionId, title: args.title })

      const resolved = await controller.resolveAgent(created.sessionId)
      if ('error' in resolved) {
        throw new Error(`会话已建但取不到 agent：${describe(resolved.error)}`)
      }
      resolved.agent.followup({
        role: 'user',
        content: [{ type: 'text', text: args.prompt }],
        source: { kind: 'plugin:dsh-console', form: 'open-session' },
      })
      return { sessionId: created.sessionId, cwd: args.cwd }
    },
  })

  const disposers = [notifyTool, openSessionTool].map(definition => tools.register(definition))
  ctx.logger.info('console: 已注册 agent 工具 console_notify / open_session')
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 目录必须真的在：拿一个不存在的目录建会话比不建更糟。 */
function assertDirectory(path: string): void {
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new Error(`工作目录不存在或不是目录：${path}`)
}

/** 把宿主给的错误折成一句人能读的话。 */
function describe(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
