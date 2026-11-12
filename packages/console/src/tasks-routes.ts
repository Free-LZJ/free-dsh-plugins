/**
 * 任务路由：看板读写那一条链的唯一 HTTP 面。
 *
 * 与旧看板路由的区别是**它只认任务**：没有 ingest、没有派单、没有执行器。任务从哪
 * 来由连接器 `emit` 决定，任务做什么由规则决定——这里只负责「读一份快照」和
 * 「撤销/承认/批准一条建议」。
 *
 * 守卫沿用工作台自己的：读要同源，写还要 `x-dsh-console: 1` 与 JSON 类型。
 *
 * @module @free-lzj/dsh-console/tasks-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ArchiveRhythm, RunningSession, TaskConnectorInfo } from './protocol.ts'
import { isMutationRequest, isSameOrigin, readJsonBody, respond } from './routes.ts'
import { WORKBENCH_ACTION_PATH, WORKBENCH_STATE_PATH } from './paths.ts'

/** 这些路由从引擎与宿主拿到的全部东西。 */
export interface TasksRouteHost {
  /** 读：任务、连接器、版本。 */
  readonly view: () => {
    readonly tasks: readonly unknown[]
    readonly connectors: readonly TaskConnectorInfo[]
    readonly revision: number
  }
  /** 正在跑的会话（首页与看板都用它判断「这条链还活着」）。 */
  readonly running: () => readonly RunningSession[]
  /** 归档节奏（用户偏好）。 */
  readonly rhythm: () => ArchiveRhythm
  /** 撤销一个任务。 */
  readonly undo: (taskId: string) => Promise<{ readonly ok: boolean; readonly message: string }>
  /** 记下「这个任务我看到了」。 */
  readonly acknowledge: (taskId: string, acknowledged: boolean) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** 批准一条排队中的建议。 */
  readonly applyDeferred: (deferredId: string) => Promise<{ readonly ok: boolean; readonly message: string }>
  /** 打开或关掉一个连接器的规则参与（不卸载插件）。 */
  readonly setConnector: (id: string, enabled: boolean) => Promise<{ readonly ok: boolean; readonly message?: string }>
}

/**
 * 挂载两个路由。
 * @param ctx - Host 上下文。
 * @param host - 引擎与宿主状态。
 */
export function registerTasksRoutes(ctx: Context, host: TasksRouteHost): void {
  ctx.inject(['webServer'], (inner) => {
    const register = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      label: string,
    ): void => {
      inner.effect(() => inner.webServer.register({ kind: 'exact', path, handler }), label)
    }

    /** 包一层：同源校验 + 异常折成一句话。 */
    const guard = (
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      what: string,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      return async (req, res) => {
        if (!isSameOrigin(req)) {
          respond(res, 403, { error: 'cross-origin request refused' })
          return
        }
        try {
          await handler(req, res)
        } catch (error: unknown) {
          ctx.logger.warn(`tasks: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    /** 写路由：POST + 页面头。 */
    const guardMutation = (
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
      what: string,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      return guard(async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respond(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isMutationRequest(req)) {
          respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
          return
        }
        await handler(req, res)
      }, what)
    }

    register(WORKBENCH_STATE_PATH, guard((req, res) => {
      if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      const view = host.view()
      const since = queryOf(req).get('since')
      // 结构没变：只回一个短回答，页面不必重画。
      if (since !== null && since === String(view.revision)) {
        respond(res, 200, { unchanged: true, revision: view.revision })
        return
      }
      respond(res, 200, {
        tasks: view.tasks,
        connectors: view.connectors,
        // 旧字段：前端还有几处读它们（会话列表、连接器页）。留着比让页面炸好。
        cards: [],
        sessions: [],
        running: host.running(),
        archiveRhythm: host.rhythm(),
        revision: view.revision,
      })
    }, 'reading tasks'), 'console.tasks-state-route')

    register(WORKBENCH_ACTION_PATH, guardMutation(async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const value = (body.value ?? {}) as Record<string, unknown>
      const action = value['action']
      const taskId = typeof value['taskId'] === 'string' ? value['taskId'] : undefined
      const result = await runAction(host, action, taskId, value)
      respond(res, result.ok ? 200 : 400, result)
    }, 'running a task action'), 'console.tasks-action-route')
  })
}

/** 一个动作的结果。 */
interface ActionResult {
  readonly ok: boolean
  readonly message?: string
}

/**
 * 跑一个任务动作。
 * @param host - 引擎与宿主状态。
 * @param action - `undo` / `acknowledge` / `apply`。
 * @param taskId - 目标任务。
 * @param body - 原始请求体（`acknowledge` 与 `apply` 要额外字段）。
 * @returns 结果。
 */
async function runAction(
  host: TasksRouteHost,
  action: unknown,
  taskId: string | undefined,
  body: Readonly<Record<string, unknown>>,
): Promise<ActionResult> {
  if (action === 'undo') {
    if (taskId === undefined) return { ok: false, message: 'undo needs a taskId' }
    return await host.undo(taskId)
  }
  if (action === 'acknowledge') {
    if (taskId === undefined) return { ok: false, message: 'acknowledge needs a taskId' }
    const acknowledged = body['acknowledged'] !== false
    return await host.acknowledge(taskId, acknowledged)
  }
  if (action === 'apply') {
    const deferredId = typeof body['deferredId'] === 'string' ? body['deferredId'] : undefined
    if (deferredId === undefined) return { ok: false, message: 'apply needs a deferredId' }
    return await host.applyDeferred(deferredId)
  }
  if (action === 'toggle-connector') {
    const connectorId = typeof body['connectorId'] === 'string' ? body['connectorId'] : undefined
    if (connectorId === undefined) return { ok: false, message: 'toggle-connector needs a connectorId' }
    return await host.setConnector(connectorId, body['enabled'] !== false)
  }
  return { ok: false, message: `unknown action "${String(action)}"` }
}

/** 解析查询串（不信任请求行）。 */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}
