/**
 * The rule engine's home and its HTTP surface.
 *
 * Two things live here, and they belong together: **where** the workbench keeps
 * the rule state, and the routes its own page reads and writes it through. The
 * engine itself is `@free-lzj/dsh-decision`'s {@link DecisionEngine} — a library
 * that knows how to read a rule file, queue an action and undo it, but not what
 * a mail or a condition kind is. Connectors register that knowledge at mount
 * time; this module never enumerates one.
 *
 * Guards are the workbench's own, reused rather than restated: a read must come
 * from the page this server sent, a write must additionally carry
 * `x-dsh-console: 1` and a JSON content type.
 *
 * @module @free-lzj/dsh-console/rules
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Task, TaskEngine } from '@free-lzj/dsh-decision'
import { isMutationRequest, isSameOrigin, readJsonBody, respond } from '../routes.ts'
import { STATE_DIR } from '../store.ts'
import {
  RULES_ACK_PATH, RULES_CONDITION_PATH, RULES_ENABLE_PATH, RULES_PRIORITY_PATH, RULES_FLOW_PATH,
  RULES_FLOW_SAVE_PATH,
  RULES_FLOW_LAYOUT_PATH,
  RULES_FLOW_NODE_PATH,
  RULES_NODE_TYPES_PATH,
  RULES_RUNS_PATH,
  RULES_STATE_PATH, RULES_TEST_PATH, RULES_UNDO_PATH,
} from '../paths.ts'

/**
 * The rule state's directory: `$DSH_HOME/dsh-console/rules/`.
 *
 * Beside the preferences rather than inside a plugin's own directory: the rule
 * file is the workbench's, and a connector that comes and goes must not move it.
 * @param dshHome - the harness home directory.
 * @returns absolute path of the directory holding rules.yml / runs.json / pending.json.
 */
export function rulesHome(dshHome: string): string {
  return join(dshHome, STATE_DIR, 'rules')
}

/**
 * The operations these routes need from the engine.
 *
 * `Pick` rather than the class: a route spec drives a fake, and the engine's
 * other verbs (start/stop/use) are not HTTP's business.
 */
export type RulesEngine = Pick<
  TaskEngine,
  | 'rules' | 'setEnabled' | 'setConditionValues' | 'movePriority' | 'listRuns' | 'undo' | 'acknowledge' | 'test'
  | 'flowView' | 'nodeTypes' | 'saveFlowNode' | 'addFlowNode' | 'removeFlowNode' | 'relinkFlowEdge' | 'addFlowEdge' | 'saveFlowEdge' | 'addRule' | 'autoLayout'
>

/** Everything the routes need from the plugin, injected so this module stays about HTTP. */
export interface RulesRouteHost {
  readonly engine: RulesEngine
}

/** One accepted write: run it, or say why it made no sense. */
type RulesCommand = (engine: RulesEngine) => Promise<{ readonly ok: boolean; readonly message?: string }>

/**
 * Mount the rule engine's routes.
 * @param ctx - the Host plugin context.
 * @param host - the engine they read and write.
 */
export function registerRulesRoutes(ctx: Context, host: RulesRouteHost): void {
  ctx.inject(['webServer'], (inner) => {
    const register = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      label: string,
    ): void => {
      inner.effect(() => inner.webServer.register({ kind: 'exact', path, handler }), label)
    }

    /**
     * Wrap a handler so a refusal is heard and a throw answers instead of escaping.
     * @param handler - the route body.
     * @param what - the operation named in logs and in the error answer.
     * @returns the guarded handler.
     */
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
          // Never echo request data back; the page gets a stable sentence instead.
          ctx.logger.warn(`console: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    /**
     * One POST-only write: the page-only header, a bounded JSON body, then the command.
     * @param path - the route.
     * @param what - the log label.
     * @param read - turns the parsed body into a command, or says why it cannot.
     */
    const registerWrite = (
      path: string,
      what: string,
      read: (body: unknown) => { readonly ok: true; readonly command: RulesCommand } | { readonly ok: false; readonly error: string },
    ): void => {
      register(path, guard(async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respond(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isMutationRequest(req)) {
          respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
          return
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          respond(res, body.status, { error: body.error })
          return
        }
        const parsed = read(body.value)
        if (!parsed.ok) {
          respond(res, 400, { error: parsed.error })
          return
        }
        const result = await parsed.command(host.engine)
        // A refusal carries the reason so the page can show it next to the rule.
        // 除了 ok，还可能有 nodeId / edgeIndex 这类「刚做了什么」的信息，一并交回去。
        respond(res, result.ok ? 200 : 400, result.ok ? { ...result, ok: true } : { error: result.message ?? 'rejected' })
      }, what), `console.${what.replaceAll(' ', '-')}-route`)
    }
    register(RULES_STATE_PATH, guard((_req, res) => {
      respond(res, 200, host.engine.rules())
    }, 'reading rule file'), 'console.rules-state-route')

    // 节点图：画布要的那一份。坐标在这里就算好，前端只管画。
    register(RULES_FLOW_PATH, guard((req, res) => {
      // ?focus=<规则 id> 只画那一条分支，坐标按筛完的节点重算。
      const focus = queryOf(req).get('focus') ?? undefined
      respond(res, 200, host.engine.flowView(focus))
    }, 'reading flow graph'), 'console.rules-flow-route')

    // 能放什么。属性面板靠它生成表单，所以字段表也一并给出去。
    register(RULES_NODE_TYPES_PATH, guard((_req, res) => {
      respond(res, 200, { types: host.engine.nodeTypes() })
    }, 'reading node types'), 'console.rules-node-types-route')

    // 改一个节点。坐标、配置、名字、启用都走这里；整图不交上来，避免覆盖别人的改动。
    // 自动布局：换方向 / 换策略之后把所有节点的坐标重算并写回。
    registerWrite(RULES_FLOW_LAYOUT_PATH, 'laying out a flow', (body) => {
      const flowId = textOf(body, 'flowId')
      if (flowId === undefined) return { ok: false, error: 'flowId must not be empty' }
      const record = isObject(body) ? body : {}
      const direction = textOf(record, 'direction')
      const strategy = textOf(record, 'strategy')
      const align = textOf(record, 'align')
      return {
        ok: true,
        command: engine => engine.autoLayout({
          flowId,
          ...(direction === undefined ? {} : { direction: direction as never }),
          ...(strategy === undefined ? {} : { strategy: strategy as never }),
          ...(align === undefined ? {} : { align: align as never }),
        }),
      }
    })

    registerWrite(RULES_FLOW_SAVE_PATH, 'saving a flow node', (body) => {
      const nodeId = textOf(body, 'nodeId')
      if (nodeId === undefined) return { ok: false, error: 'nodeId must not be empty' }
      const record = isObject(body) ? body : {}
      // `trigger` / `branch` 这类 id 每张图里都有，必须靠 flowId 才知道改的是哪张图。
      const flowId = textOf(body, 'flowId')
      const config = record['config']
      const rawPos = record['pos']
      const x = isObject(rawPos) ? rawPos['x'] : undefined
      const y = isObject(rawPos) ? rawPos['y'] : undefined
      const label = record['label']
      const enabled = record['enabled']
      return {
        ok: true,
        command: engine => engine.saveFlowNode({
          nodeId,
          ...(flowId === undefined ? {} : { flowId }),
          ...(isObject(config) ? { config } : {}),
          ...(typeof x === 'number' && typeof y === 'number' ? { pos: { x, y } } : {}),
          ...(typeof label === 'string' ? { label } : {}),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        }),
      }
    })

    // 增删节点与改边指向。插入时新节点接管前一步的出路，删除时入边接到出边——
    // 都不用手动连线；要换指向就单独说一条边。
    registerWrite(RULES_FLOW_NODE_PATH, 'editing the flow structure', (body) => {
      const record = isObject(body) ? body : {}
      // 新增一条出边：从 A 连到 B，可选带条件。这就是「新建规则」的最后一环。
      // 改一条边的条件：条件是「这条规则凭什么被选中」。
      // 新建一条规则：建子工作流 + 加节点 + 连线，一次做完。
      if (record['action'] === 'rule') {
        const flowId = textOf(body, 'flowId')
        const from = textOf(body, 'from')
        const name = textOf(body, 'name')
        if (flowId === undefined || from === undefined || name === undefined) {
          return { ok: false, error: 'flowId, from and name are required' }
        }
        return { ok: true, command: engine => engine.addRule({ flowId, from, name }) }
      }
      // 改一条边的条件：条件是「这条规则凭什么被选中」。
      if (record['action'] === 'when') {
        const from = textOf(body, 'from')
        const index = intOf(body, 'index')
        if (from === undefined || index === undefined) {
          return { ok: false, error: 'from and index are required' }
        }
        const flowId = textOf(body, 'flowId')
        const when = Array.isArray(record['when']) ? record['when'] : undefined
        return {
          ok: true,
          command: engine => engine.saveFlowEdge({
            from,
            index,
            ...(flowId === undefined ? {} : { flowId }),
            ...(when === undefined ? {} : { when: when as never }),
          }),
        }
      }
      // 新增一条出边：从 A 连到 B，可选带条件。这就是「新建规则」的最后一环。
      if (record['action'] === 'connect') {
        const from = textOf(body, 'from')
        const to = textOf(body, 'to')
        if (from === undefined || to === undefined) {
          return { ok: false, error: 'from and to are required' }
        }
        const flowId = textOf(body, 'flowId')
        const when = Array.isArray(record['when']) ? record['when'] : undefined
        const mode = textOf(body, 'mode')
        return {
          ok: true,
          command: engine => engine.addFlowEdge({
            from,
            to,
            ...(flowId === undefined ? {} : { flowId }),
            ...(when === undefined ? {} : { when: when as never }),
            ...(mode === 'fork' ? { mode: 'fork' as const } : {}),
          }),
        }
      }
      if (record['action'] === 'link') {
        const from = textOf(body, 'from')
        const index = intOf(body, 'index')
        if (from === undefined || index === undefined) {
          return { ok: false, error: 'from and index are required' }
        }
        const to = textOf(body, 'to')
        return {
          ok: true,
          command: engine => engine.relinkFlowEdge({
            from,
            index,
            ...(to === undefined ? {} : { to }),
          }),
        }
      }
      if (record['action'] === 'remove') {
        const nodeId = textOf(body, 'nodeId')
        if (nodeId === undefined) return { ok: false, error: 'nodeId must not be empty' }
        return { ok: true, command: engine => engine.removeFlowNode(nodeId) }
      }
      if (record['action'] !== 'add') return { ok: false, error: 'action must be add or remove' }
      const type = textOf(body, 'type')
      if (type === undefined) return { ok: false, error: 'type must not be empty' }
      const after = textOf(body, 'after')
      const config = record['config']
      return {
        ok: true,
        command: engine => engine.addFlowNode({
          type,
          ...(after === undefined ? {} : { after }),
          ...(isObject(config) ? { config } : {}),
        }),
      }
    })

    register(RULES_RUNS_PATH, guard((req, res) => {
      const since = queryOf(req).get('since')
      respond(res, 200, { runs: host.engine.listRuns(since ?? undefined).map(toRunView) })
    }, 'reading hit records'), 'console.rules-runs-route')

    registerWrite(RULES_ENABLE_PATH, 'switching a rule', (body) => {
      const ruleId = textOf(body, 'ruleId')
      if (ruleId === undefined) return { ok: false, error: 'ruleId must not be empty' }
      const enabled = (body as Record<string, unknown>)['enabled'] === true
      return { ok: true, command: async engine => await engine.setEnabled(ruleId, enabled) }
    })

    registerWrite(RULES_CONDITION_PATH, 'editing condition values', (body) => {
      const ruleId = textOf(body, 'ruleId')
      const conditionIndex = intOf(body, 'conditionIndex')
      const raw = (body ?? {}) as Record<string, unknown>
      const values = Array.isArray(raw['values'])
        ? raw['values'].filter((value): value is string => typeof value === 'string')
        : []
      if (ruleId === undefined || conditionIndex === undefined) {
        return { ok: false, error: 'ruleId and conditionIndex are both required' }
      }
      return { ok: true, command: async engine => await engine.setConditionValues(ruleId, conditionIndex, values) }
    })

    registerWrite(RULES_PRIORITY_PATH, 'moving a rule', (body) => {
      const ruleId = textOf(body, 'ruleId')
      const direction = textOf(body, 'direction')
      if (ruleId === undefined || (direction !== 'up' && direction !== 'down')) {
        return { ok: false, error: 'ruleId and direction (up|down) are required' }
      }
      return { ok: true, command: async engine => await engine.movePriority(ruleId, direction) }
    })

    registerWrite(RULES_UNDO_PATH, 'undoing a hit', (body) => {
      const runId = textOf(body, 'runId')
      if (runId === undefined) return { ok: false, error: 'runId must not be empty' }
      return { ok: true, command: async engine => await engine.undo(runId) }
    })

    registerWrite(RULES_ACK_PATH, 'acknowledging a hit', (body) => {
      const runId = textOf(body, 'runId')
      if (runId === undefined) return { ok: false, error: 'runId must not be empty' }
      // 只认显式的 false 为「取消标记」，其余一律当作标记：一个手抖打成 null 的请求
      // 不该把一条人刚收起来的记录又弹回待办。
      const raw = (body ?? {}) as Record<string, unknown>
      const acknowledged = raw['acknowledged'] !== false
      return { ok: true, command: async engine => await engine.acknowledge(runId, acknowledged) }
    })

    // 试跑成功时回答的是试跑结果本身，不是 `{ ok: true }`，所以不走上面那个包装。
    register(RULES_TEST_PATH, guard(async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isMutationRequest(req)) {
        respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const accountId = textOf(body.value, 'accountId')
      const folder = textOf(body.value, 'folder')
      const uid = intOf(body.value, 'uid')
      if (accountId === undefined || folder === undefined || uid === undefined || uid <= 0) {
        respond(res, 400, { error: 'accountId, folder and a positive uid are required' })
        return
      }
      const answer = await host.engine.test({ accountId, folder, uid })
      if (!answer.ok) {
        respond(res, 400, { error: answer.message })
        return
      }
      respond(res, 200, answer.result)
    }, 'trying the rules'), 'console.rules-test-route')
  })
}

/**
 * 把一个任务折成页面现在读的「命中记录」形状。
 *
 * 这是**过渡层**：任务链是新的真相，页面还按旧的 run 形状画。它只做投影、不改状态，
 * 前端切到 `TaskState` 之后这一段就可以删。
 * @param task - 一个任务。
 * @returns 旧前端认识的记录。
 */
function toRunView(task: Task): Record<string, unknown> {
  const rule = task.nodes.find(node => node.kind === 'rule')
  const classify = task.nodes.find(node => node.kind === 'classify')
  const ruleData = (rule?.data ?? {}) as { readonly ruleId?: unknown; readonly ruleName?: unknown; readonly label?: unknown }
  const classifyData = (classify?.data ?? {}) as { readonly label?: unknown }
  const actionSessions = new Set(
    task.nodes
      .filter(node => node.kind !== 'session' && node.sessionId !== undefined)
      .map(node => node.sessionId as string),
  )
  const actions = task.nodes
    .filter(node => node.kind !== 'trigger' && node.kind !== 'classify' && node.kind !== 'rule')
    // 会话节点：动作自己带 sessionId 的那一格已经够页面画了；只有「触发器就带着会话」
    // 的那种（`open_session` 工具）需要单独补一格。
    .filter(node => node.kind !== 'session' || (node.sessionId !== undefined && !actionSessions.has(node.sessionId)))
    .map(node => ({
      kind: node.kind,
      mode: typeof node.data?.['mode'] === 'string' ? node.data['mode'] : 'auto',
      ok: node.ok,
      detail: node.detail,
      ...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
      ...(node.failure === undefined ? {} : { failure: node.failure }),
    }))
  return {
    id: task.id,
    at: task.at,
    ruleId: typeof ruleData.ruleId === 'string' ? ruleData.ruleId : '',
    ruleName: typeof ruleData.ruleName === 'string' ? ruleData.ruleName : '',
    label: typeof classifyData.label === 'string'
      ? classifyData.label
      : (typeof ruleData.label === 'string' ? ruleData.label : ''),
    event: task.event.payload,
    actions,
    /**
     * 图上的足迹：每一格带着它在图里的节点 id，画布据此把方块标成成了还是失败了。
     *
     * 与 ctions 分开：那一份是「这条规则做了什么」，筛掉了触发与分类，给列表看；
     * 这一份是「图上哪些方块跑过了」，给画布看，一格都不筛。
     */
    nodes: task.nodes.map(node => ({
      ...(node.nodeId === undefined ? {} : { nodeId: node.nodeId }),
      kind: node.kind,
      ok: node.ok,
      detail: node.detail,
      ...(node.failure === undefined ? {} : { failure: node.failure }),
    })),
    status: task.status,
    ...(task.undoableUntil === undefined ? {} : { undoableUntil: task.undoableUntil }),
    ...(task.acknowledged === true ? { acknowledged: true } : {}),
  }
}

/** One non-empty trimmed string field, or undefined. */
function textOf(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 一个 JSON 对象字段是不是对象；
ull 与数组都不算。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One non-negative integer field, or undefined (a JSON number or the text a form sends). */
function intOf(body: unknown, key: string): number | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

/** Parse one request's query string without trusting the request line. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}
