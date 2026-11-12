/**
 * 工作台的会话能力：交给工具与连接器的那几个动词。
 *
 * 只有一件事值得写在这里：**建会话时把工作区登记上**。宿主按会话 header 里的 `cwd`
 * 做 realpath 比对来决定它属于哪个工作区，不登记就落进侧边栏的「未分组」——而那是
 * 用户看得见、会问「这些会话是谁建的」的地方。
 *
 * 与旧实现的区别：这里不再有看板。任务链由连接器 `emit` 产生，会话只是链上的一格；
 * 这个端口只负责「把会话建出来并挂对地方」。
 *
 * @module @free-lzj/dsh-console/workbench/session-port
 */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** 一个活着的 agent，就本端口用得到的部分。 */
export interface ControllerAgentLike {
  readonly session?: {
    readonly id?: string
    append?(type: string, data: unknown): unknown
  }
  followup(message: unknown): unknown
}

/** 会话服务里本端口驱动的那些方法。 */
export interface SessionControllerLike {
  create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<{ readonly agent: ControllerAgentLike } | { readonly error: unknown }>
}

/** 工作区表：按路径取/建，再把会话挂上去。 */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<{ attachSession(sessionId: string): Promise<void> }>
  resolveByPath(path: string): Promise<{ attachSession(sessionId: string): Promise<void> } | undefined>
}

/** 连接器可以调的那几个会话动词。 */
export interface WorkbenchSessionPort {
  createSession(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  attachSession(cwd: string, sessionId: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  setPermission(sessionId: string, preset: string): void
  followup(sessionId: string, text: string, source: Readonly<Record<string, unknown>>): Promise<void>
}

/**
 * 造端口。
 *
 * 服务在**调用时**取：宿主可能比本插件晚挂载，注册时取一次会把它们永久记成缺失。
 * @param ctx - Host 上下文。
 * @param log - 一句日志出口（工作区登记失败只记这里，不让调用方失败）。
 * @returns 端口。
 */
export function createWorkbenchSessionPort(ctx: Context, log: (line: string) => void): WorkbenchSessionPort {
  const controller = (): SessionControllerLike | undefined =>
    ctx.get('sessionController') as SessionControllerLike | undefined
  const registry = (): WorkspaceRegistryLike | undefined =>
    ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined

  /** 把一个会话挂到它 cwd 对应的工作区；失败只说一句。 */
  const attach = async (cwd: string, sessionId: string): Promise<void> => {
    const table = registry()
    if (table === undefined) return
    try {
      const existing = await table.resolveByPath(cwd).catch(() => undefined)
      const workspace = existing ?? await table.create(cwd)
      await workspace.attachSession(sessionId)
    } catch (error: unknown) {
      log(`会话 ${sessionId.slice(0, 8)} 没能登记到工作区 ${cwd}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async createSession(request) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController），无法新建会话')
      // 宿主不替我们建目录，而一个不存在的 cwd 会让建会话直接失败。
      try {
        mkdirSync(request.cwd, { recursive: true })
      } catch {
        // 已存在或没权限：交给 create 自己报错，比在这里吞掉清楚。
      }
      return await service.create(request)
    },

    async attachSession(cwd, sessionId) {
      await attach(cwd, sessionId)
    },

    async rename(sessionId, title) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController）')
      if (service.rename !== undefined) {
        await service.rename({ sessionId, title })
        return
      }
      const resolved = await service.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`会话 ${sessionId} 不可用`)
      resolved.agent.session?.append?.('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    },

    setPermission() {
      // 权限是会话上的 `permission/*` 事件，而工具只带一个 id：这一版不假装挂上。
    },

    async followup(sessionId, text, source) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController）')
      const resolved = await service.resolveAgent(sessionId)
      if ('error' in resolved) {
        const message = (resolved.error as { readonly message?: string } | undefined)?.message
        throw new Error(`会话 ${sessionId} 不可用：${message ?? String(resolved.error)}`)
      }
      resolved.agent.followup({ role: 'user', content: [{ type: 'text', text }], source })
    },
  }
}
