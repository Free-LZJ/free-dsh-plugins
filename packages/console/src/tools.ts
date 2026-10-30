/**
 * Agent 可调用的两个工具：告诉你一件事、在某个目录里开一个会话。
 *
 * 为什么住在工作台：前者正是 `ctx.console` 的门面（通知中心 + 桌面通知），后者用的是
 * 工作台自己的会话端口。这个端口是本机**实测可用**的 `sessionController`
 * （mail 的分类会话就是它建的）：建会话 → 起名 → 投递，不再依赖宿主里不存在的
 * `agents.createSession`。
 *
 * `tools` 与会话服务都是**可选**的：缺了就少一个能力，绝不半挂
 * （`rules/design-patterns.md`）。所以工具在注册那一刻探测工具注册表，`open_session`
 * 在调用时再探测会话端口，缺了返回一句人话。
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

/** 一个工作区，就本模块用得到的两件事：它叫什么、能不能挂一个会话。 */
interface WorkspaceLike {
  readonly title?: string
  attachSession(sessionId: string): Promise<void>
}

/** 工作区表里本模块用得到的部分：按目录建一个（已存在则复用同一个）。 */
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
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

  /**
   * 调用这个工具的会话属于哪条链路。
   *
   * 工具自己不知道「我这次是在替哪件事干活」——但宿主知道调用它的会话，而会话
   * 已经登记在链路上（`open_session` 建会话时就登记了）。这一跳让子会话、子通知
   * 自动归到触发它的那件事下，不需要模型多传一个参数（它传错比不传更糟）。
   * @param exec - 工具调用上下文。
   * @returns 根卡 id；没有会话上下文时 undefined。
   */
  const rootOf = (exec: { readonly agent?: unknown } | undefined): string | undefined => {
    // 老版本工具运行时不传第二个参数：那时没有会话上下文，就当它不属于任何链。
    const agent = exec?.agent as { readonly sessionId?: unknown } | undefined
    const sessionId = agent?.sessionId
    return typeof sessionId === 'string' ? host.rootOfSession(sessionId) : undefined
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
    async execute(args, exec) {
      const rootId = rootOf(exec)
      await host.notify({
        title: args.title,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.tone === undefined ? {} : { tone: args.tone }),
        ...(rootId === undefined ? {} : { rootId }),
        source: 'agent',
      })
      return { ok: true, title: args.title }
    },
  })

  const openSessionTool = defineTool({
    name: 'open_session',
    description:
      '在一个已存在的工作目录里新建 DSH 工作区，并在其中开一个会话，把 prompt 作为它的第一条消息投递进去。用于「活要落在某个具体仓库里干」的场面（例如派单后到项目目录里开工）。目录必须已经存在，本工具不建目录。会话会归到该目录的工作区下。',
    parameters: {
      cwd: { type: 'string', required: true, description: '绝对路径，且必须是已存在的目录（通常是一个仓库）' },
      title: { type: 'string', required: true, description: '会话标题，一眼能看出这是哪件事' },
      prompt: { type: 'string', required: true, description: '投递给新会话的第一条消息' },
      agentPreset: { type: 'string', description: '可选的 agent 预设 id；不给就用部署默认' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          cwd: { type: 'string' },
          workspace: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在 ${value.cwd} 新建会话 ${value.sessionId}（工作区：${value.workspace}）`,
      }],
    },
    async execute(args, exec) {
      if (!isAbsolute(args.cwd)) throw new Error(`工作目录必须是绝对路径：${args.cwd}`)
      assertDirectory(args.cwd)
      const sessions = host.sessions
      if (sessions === undefined) {
        throw new Error('这个部署没有提供建会话的能力（sessionController），无法新建会话')
      }

      // 工作区先建：这一步失败时还没有会话，不会留下一个掉进「未分组」的孤儿。
      const workspace = await requireWorkspace(ctx, args.cwd)
      // 顺序与邮件动作一致：先建出会话，挂好工作区，再起名，最后才投递第一条消息。
      const created = await sessions.createSession({
        cwd: args.cwd,
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
      })
      // 派单的会话属于调用它的那条链：先登记，第一条消息建卡时才有根可归。
      const rootId = rootOf(exec)
      if (rootId !== undefined) host.linkSession(created.sessionId, rootId)
      await workspace.attachSession(created.sessionId)
      await sessions.rename(created.sessionId, args.title)
      await sessions.followup(created.sessionId, args.prompt, {
        kind: 'plugin:dsh-console',
        form: 'open-session',
      })
      return { sessionId: created.sessionId, cwd: args.cwd, workspace: workspace.title ?? args.cwd }
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

/**
 * 给会话所在目录取一个工作区（没有就建，已存在则复用）。
 *
 * 为什么必须给这个目录本身建一个：工作区是**精确目录**身份——成员资格要求会话
 * `cwd` 的 realpath 等于工作区 `path`，父仓库那个工作区装不下
 * `.agents/worktrees/<单号>` 里的会话，拖也拖不进去。缺这样一次登记，会话就只能
 * 落在侧边栏的「未分组」。
 * @param ctx - Host 上下文，工作区表按可选协作者探测。
 * @param cwd - 会话的工作目录（已确认存在）。
 * @returns 这个目录的工作区。
 */
async function requireWorkspace(ctx: Context, cwd: string): Promise<WorkspaceLike> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry?.create === undefined) {
    throw new Error('这个部署没有工作区表（workspaceRegistry），无法把会话归到目录分组下')
  }
  return await registry.create(cwd)
}
