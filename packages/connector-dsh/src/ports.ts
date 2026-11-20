/**
 * 宿主能力端口：这一侧唯一碰 `sessionController` / `workspaceRegistry` /
 * `subprocess` / `tools` / `llm` 的地方。
 *
 * 端口是「核心不认识、动作要用的东西」的容器。动作实现只读 `context.ports`，
 * 因此这一整个文件都可以在测试里换成假的——这也是「动作不知道宿主长什么样」的
 * 落地方式。
 *
 * @module @free-lzj/dsh-connector-dsh/ports
 */

import { mkdirSync } from 'node:fs'
import type { ActionOutcome, ActionSpecLike, SessionPort, TaskConnector, TaskContext } from '@free-lzj/dsh-decision'

/** 会话服务里本插件用得到的那部分。 */
export interface SessionControllerLike {
  create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ readonly agent: AgentLike } | { readonly error: unknown }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  archive?(sessionId: string): Promise<unknown>
}

/** 一个活着的 agent；`session` 用来改名，`followup` 用来投话。 */
export interface AgentLike {
  readonly session?: {
    readonly id?: string
    append?(type: string, data: unknown): unknown
  }
  /**
   * 宿主报的活状态：`running` 是正在跑一轮，`idle` 是没人在驱动它。
   *
   * 旧宿主没有这个字段，所以是可选的——没有它就只能按时间宽限判断（见 `probe`）。
   */
  readonly status?: 'idle' | 'running'
  /** 等这个 agent 彻底静下来；宿主有就给，探针不阻塞地用它。 */
  whenIdle?(): Promise<void>
  followup(message: unknown): unknown
}

/** 工作区表：本插件只用到「按路径取/建」与「挂会话」。 */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

/** 一个工作区。 */
export interface WorkspaceLike {
  readonly title?: string
  attachSession(sessionId: string): Promise<void>
}

/** 子进程能力。 */
export interface SubprocessLike {
  spawn(spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
  }): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>
}

/** 工具能力（MCP 走这里）。 */
export interface ToolsLike {
  call?(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>
}

/**
 * 连接器用到的宿主能力，只有一个动词：取一个服务。
 *
 * 结构声明而不是 import cordis 的 `Context`：本包是**库**，两个包各自解析到的
 * cordis 版本一旦不同，同一个 `ctx` 在类型上就不兼容了——而运行时它是同一个对象。
 */
export interface ServiceLookup {
  get(name: string): unknown
}

/** 通知端口：工作台自己的 `ctx.console` 那一小块。 */
export interface ConsoleLike {
  notify?(notice: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
  }): Promise<unknown>
}

/** LLM 端口：宿主 `ctx.llm` 的实际形状（`prepareCall → stream` 的 text-delta）。 */
export interface LlmLike {
  prepareCall(
    route: unknown,
    signal: AbortSignal,
    controls: (current: unknown) => unknown,
  ): Promise<{
    readonly config: unknown
    stream(input: unknown): AsyncIterable<{ readonly type?: string; readonly text?: string }>
  }>
}

/** 端口袋子。 */
export interface DshPorts {
  readonly sessions: SessionPort
  readonly subprocess?: SubprocessLike
  readonly tools?: ToolsLike
  readonly fetch: typeof globalThis.fetch
  readonly console?: ConsoleLike
  readonly llm?: LlmLike
  readonly [key: string]: unknown
}

/** 动作实现里取端口：`portsOf(context).sessions`。 */
export function portsOf(context: TaskContext): DshPorts {
  return context.ports as unknown as DshPorts
}

/** 一次「会话干完了吗」的探视结果。 */
export interface SessionProbe {
  readonly ready: boolean
  readonly status?: 'idle' | 'running'
  /** 一句给看板/记录看的说明。 */
  readonly detail: string
}

/** 会话端口额外的动词（不在内核 `SessionPort` 里，但这个插件要用）。 */
export interface DshSessionPort extends SessionPort {
  /** 会话是不是这个端口建的；投递到别人的常驻会话时不该去改它的归属。 */
  knows(sessionId: string): boolean
  /**
   * 看一眼这个会话干完没有。**不阻塞**：到期扫描每隔几秒就问一遍所有在等的任务。
   * @param sessionId - 宿主会话 id。
   * @returns 探视结果。
   */
  probe(sessionId: string): Promise<SessionProbe>
}

/**
 * 造会话端口：建会话、**登记工作区**、改名、投递。
 *
 * 工作区登记是「类型 A 会话出现在它自己的工作区」的唯一实现点：
 * `resolveByPath(cwd)` 已有就复用，没有就 `create(cwd)`，再 `attachSession`。
 * 登记失败**只记日志**——会话已经建出来了，"永不回滚"是这套动作的既有判断；
 * 为了一次工作区登记把动作标失败，用户会以为会话没建。
 *
 * @param ctx - Host 上下文；服务在调用时取，可能比本插件晚挂载。
 * @param log - 一句日志出口。
 * @returns 会话端口。
 */
export function createDshSessionPort(ctx: ServiceLookup, log: (line: string) => void): DshSessionPort {
  const controller = (): SessionControllerLike | undefined =>
    ctx.get('sessionController') as SessionControllerLike | undefined
  const registry = (): WorkspaceRegistryLike | undefined =>
    ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  /** 本端口建过的会话（改名与投递要能找到那只 agent）。 */
  const agents = new Map<string, AgentLike>()
  /** 本端口建过的会话集合。 */
  const created = new Set<string>()
  /** 建出来的时刻：刚建好的会话也是 idle，得靠它区分「还没开跑」与「已经干完」。 */
  const bornAt = new Map<string, number>()
  /** 见过它 running 的会话：之后再看到 idle 才算真的干完了。 */
  const sawRunning = new Set<string>()

  /** 把一个会话挂到它 cwd 对应的工作区；失败只说一句。 */
  const attach = async (cwd: string, sessionId: string): Promise<void> => {
    const table = registry()
    if (table === undefined) return
    try {
      const existing = await table.resolveByPath(cwd).catch(() => undefined)
      const workspace = existing ?? await table.create(cwd)
      await workspace.attachSession(sessionId)
    } catch (error: unknown) {
      // 截头 8 位只剩 `session-`，日志里看不出是哪个会话；留前缀 + id 前 8 位。
      log(`会话 ${sessionId.slice(0, 16)} 没能登记到工作区 ${cwd}：${describe(error)}`)
    }
  }

  return {
    async createSession(request) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController），无法新建会话')
      // 宿主不会替我们建目录，而一个不存在的 cwd 会让建会话直接失败。
      try {
        mkdirSync(request.cwd, { recursive: true })
      } catch {
        // 目录已经存在或没权限：交给 create 自己报错，比在这里吞掉更清楚。
      }
      const created_ = await service.create(request)
      created.add(created_.sessionId)
      bornAt.set(created_.sessionId, Date.now())
      return { sessionId: created_.sessionId }
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
      // 权限是会话上的 `permission/*` 事件，而规则里的动作只带一个 id：这一版
      // 不假装挂上，也不失败——记录里不会说谎。
    },

    async followup(sessionId, text, source) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController）')
      const known = agents.get(sessionId)
      if (known !== undefined) {
        known.followup({ role: 'user', content: [{ type: 'text', text }], source })
        return
      }
      const resolved = await service.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`会话 ${sessionId} 不可用：${describe(resolved.error)}`)
      agents.set(sessionId, resolved.agent)
      resolved.agent.followup({ role: 'user', content: [{ type: 'text', text }], source })
    },

    knows: sessionId => created.has(sessionId),

    async probe(sessionId) {
      const service = controller()
      if (service === undefined) return { ready: false, detail: '这个部署没有会话服务，判不了会话状态' }
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        const resolved = await service.resolveAgent(sessionId)
        if ('error' in resolved) return { ready: false, detail: '会话已经不在了' }
        agent = resolved.agent
        agents.set(sessionId, agent)
      }
      const status = agent.status
      // 不是本进程建的会话（重启后接着等的那种）：从第一次看见它开始算宽限，
      // 否则 `age` 永远是 0，这条链会一直等到超时。
      const born = bornAt.get(sessionId) ?? Date.now()
      bornAt.set(sessionId, born)
      const age = (Date.now() - born) / 1000
      if (status === 'running') {
        sawRunning.add(sessionId)
        return { ready: false, status, detail: '会话还在跑' }
      }
      if (status === 'idle') {
        // 刚建出来的会话也是 idle：没见过它跑就先宽限一分钟，别把「还没开跑」当成「干完了」。
        if (sawRunning.has(sessionId) || age >= 60) return { ready: true, status, detail: '会话跑完了' }
        return { ready: false, status, detail: '会话还没开跑' }
      }
      // 旧宿主不报状态：按时间放行，别让整条链永远挂着（超时那条会给出更准确的原因）。
      return { ready: age >= 120, detail: '宿主没报会话状态，按 2 分钟宽限放行' }
    },
  }
}

/**
 * 把端口收成 `TaskConnector.ports` 的形状。
 *
 * 宿主服务是**惰性**读的：`subprocess` / `tools` / `llm` / `console` 都可能比本插件
 * 晚挂载，注册时取一次会把它们永久记成 undefined，而这个连接器的动作正是靠它们干活的。
 * @param ctx - Host 上下文。
 * @param log - 一句日志出口。
 * @returns 端口袋子（属性是 getter）。
 */
export function createDshPorts(ctx: ServiceLookup, log: (line: string) => void): DshPorts {
  const ports: Record<string, unknown> = {
    sessions: createDshSessionPort(ctx, log),
    fetch: globalThis.fetch.bind(globalThis),
  }
  const lazy = (name: string, read: () => unknown): void => {
    Object.defineProperty(ports, name, { enumerable: true, get: read })
  }
  lazy('subprocess', () => ctx.get('subprocess'))
  lazy('tools', () => {
    const tools = ctx.get('tools') as ToolsLike | undefined
    return tools?.call === undefined ? undefined : tools
  })
  lazy('llm', () => ctx.get('llm'))
  lazy('console', () => ctx.get('console'))
  return ports as DshPorts
}

/** 一个动作的失败结果。 */
export function failure(message: string, kind: 'config' | 'transient' | 'fatal' = 'transient'): ActionOutcome {
  return { ok: false, message, failure: kind }
}

/** 一个抛出物作为一句话。 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 连接器类型的一次性别名，减少各动作文件的 import 噪声。 */
export type { ActionSpecLike, TaskConnector }
