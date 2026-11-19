/**
 * DSH 连接器：内置，但**不是特例**。
 *
 * 它注册的东西与第三方连接器完全同一套接口：一个触发器（工作台工具调用）、七个
 * 动作（会话、投递、通知、脚本、MCP、HTTP、大模型）、一组端口。工作台核心不认识
 * 「DSH」这个词，就像它不认识「邮件」。
 *
 * 动作 kind 沿用旧名（`session` / `notify` / …），所以规则文件不用改——变的只是
 * 这些动作现在由谁提供。这也正是「核心不该含实现」的检验：搬走之后 core 一行没动。
 *
 * @module @free-lzj/dsh-connector-dsh/connector
 */

import { clamped, stringList } from '@free-lzj/dsh-decision'
import type { ActionNode, ActionSpecLike, TaskConnector, TaskContext, TaskTrigger } from '@free-lzj/dsh-decision'
import { capabilityActions } from './actions/capabilities.ts'
import { followupAction, sessionAction } from './actions/session.ts'
import { SESSION_WAIT_PREFIX } from './actions/session.ts'
import { createDshPorts, type DshSessionPort, type ServiceLookup } from './ports.ts'

/** 本连接器提供的动作 kind。 */
export const DSH_ACTIONS = ['session', 'followup', 'notify', 'script', 'mcp', 'http', 'llm'] as const

/** 一个 kind 是不是本连接器的。 */
export function isDshAction(kind: string): boolean {
  return (DSH_ACTIONS as readonly string[]).includes(kind)
}

/** 从一条原始配置里取一个清洗过的字符串。 */
function field(record: Readonly<Record<string, unknown>>, key: string, limit = 4000): string | undefined {
  return clamped(record[key], limit)
}

/** 编排字段：显式延迟，原样透传。 */
function orchestration(record: Readonly<Record<string, unknown>>): Partial<ActionSpecLike> {
  const delay = record['delaySeconds']
  return {
    ...(typeof delay === 'number' && Number.isInteger(delay) && delay >= 0 ? { delaySeconds: delay } : {}),
  }
}

/**
 * 把规则文件里的一段 `then` 收成 DSH 连接器的动作配置。
 *
 * 只认自己的七个 kind；别人的返回 undefined——这是多连接器共用一份规则文件的前提。
 * @param input - 规则文件里的原始值。
 * @returns 动作配置，或 undefined（不是本连接器的动作 / 写歪了）。
 */
export function normalizeDshAction(input: unknown): ActionSpecLike | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const kind = field(record, 'kind', 40)
  if (kind === undefined || !isDshAction(kind)) return undefined
  const base = { kind, ...orchestration(record) }
  switch (kind) {
    case 'session':
      return {
        ...base,
        ...optional('workspace', field(record, 'workspace', 1000)),
        ...optional('workspacePath', field(record, 'workspacePath', 1000)),
        ...optional('workspaceTemplate', field(record, 'workspaceTemplate', 1000)),
        ...optional('titleTemplate', field(record, 'titleTemplate', 200)),
        ...optional('instructions', field(record, 'instructions', 8000)),
        ...optional('agentPreset', field(record, 'agentPreset', 120)),
        ...optional('permissionPreset', field(record, 'permissionPreset', 120)),
        ...(record['awaitSession'] === 'none' || record['awaitSession'] === 'idle'
          ? { awaitSession: record['awaitSession'] }
          : {}),
        ...(typeof record['timeoutMinutes'] === 'number'
          && Number.isInteger(record['timeoutMinutes'])
          && record['timeoutMinutes'] > 0
          ? { timeoutMinutes: record['timeoutMinutes'] }
          : {}),
      }
    case 'followup':
      return {
        ...base,
        ...optional('sessionId', field(record, 'sessionId', 200)),
        ...optional('prompt', field(record, 'prompt', 8000)),
      }
    case 'notify': {
      const tone = record['tone']
      return {
        ...base,
        ...optional('title', field(record, 'title', 200)),
        ...optional('body', field(record, 'body', 1000)),
        ...optional('link', field(record, 'link', 1000)),
        ...(tone === 'info' || tone === 'success' || tone === 'warn' || tone === 'error' ? { tone } : {}),
      }
    }
    case 'script':
      return {
        ...base,
        ...optional('command', field(record, 'command', 1000)),
        ...optional('cwd', field(record, 'cwd', 1000)),
        ...(Array.isArray(record['args']) ? { args: stringList(record['args'], 1000) ?? [] } : {}),
      }
    case 'mcp':
      return {
        ...base,
        ...optional('tool', field(record, 'tool', 200)),
        ...(typeof record['input'] === 'object' && record['input'] !== null && !Array.isArray(record['input'])
          ? { input: record['input'] as Readonly<Record<string, unknown>> }
          : {}),
      }
    case 'http':
      return {
        ...base,
        ...optional('url', field(record, 'url', 2000)),
        ...optional('method', field(record, 'method', 20)),
      }
    case 'llm': {
      const maxTokens = record['maxTokens']
      return {
        ...base,
        ...optional('prompt', field(record, 'prompt', 8000)),
        ...optional('system', field(record, 'system', 4000)),
        ...optional('model', field(record, 'model', 200)),
        ...(typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      }
    }
    default:
      return undefined
  }
}

/** 省略 undefined 字段，配合 `exactOptionalPropertyTypes`。 */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>
}

/**
 * 工作台工具触发的那个事件。
 *
 * `open_session` 工具在调用之前就把会话建好了（它要立刻返回 id），所以它把
 * `sessionId` 一起发过来，核心据此在任务链上补一格会话节点。
 *
 * **它不负责再造一条任务**：会话属于调它的那个任务，没有归属任务时就不挂。
 * 事件流里要开会话，应该写 `session` 动作（见 `actions/session.ts`），让流程自己
 * 拥有这个节点、自己决定等不等它跑完。
 */
export const toolTrigger: TaskTrigger = {
  kind: 'trigger',
  id: 'console:tool',
  connector: 'dsh',
  listensTo: ['console.tool.invoked'],
  async run(event) {
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as {
      readonly title?: unknown
      readonly sessionId?: unknown
      readonly workspace?: unknown
    }
    const title = typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title.trim() : '工作台任务'
    return {
      status: 'continue',
      ok: true,
      detail: '由工作台工具发起',
      seed: {
        key: event.dedupeKey ?? `console:tool:${String(payload.sessionId ?? title)}`,
        title,
        vars: {
          ...(typeof payload.workspace === 'string' ? { workspace: payload.workspace } : {}),
          ...(typeof payload.title === 'string' ? { subject: payload.title } : {}),
        },
      },
      ...(typeof payload.sessionId === 'string' && payload.sessionId !== '' ? { sessionId: payload.sessionId } : {}),
    }
  },
}

/** 装配一个 DSH 连接器。 */
export interface DshConnectorOptions {
  /** 一句日志出口。 */
  readonly log?: (line: string) => void
}

/**
 * 造这个连接器。
 *
 * 端口是**惰性**的（属性 getter）：`subprocess` / `tools` / `llm` 可能比本插件晚挂载，
 * 注册时取一次会把它们永久记成 undefined。
 * @param ctx - Host 上下文。
 * @param options - 日志出口。
 * @returns 可以直接交给 `TaskCore.register` 的连接器。
 */
export function createDshConnector(ctx: ServiceLookup, options: DshConnectorOptions = {}): TaskConnector {
  const log = options.log ?? (() => undefined)
  const ports = createDshPorts(ctx, log)
  const actions: ActionNode<ActionSpecLike, TaskContext>[] = [
    sessionAction as ActionNode<ActionSpecLike, TaskContext>,
    followupAction as ActionNode<ActionSpecLike, TaskContext>,
    ...capabilityActions(),
  ]
  return {
    id: 'dsh',
    label: 'DSH 宿主能力',
    directions: ['out'],
    implemented: true,
    note: '会话、投递、通知、脚本、MCP、HTTP、大模型；会话按工作区登记，所以它出现在侧边栏对应目录下。',
    triggers: [toolTrigger],
    actions,
    ports,
    async probeWait(wait) {
      // 只认自己那类等待：别的令牌（工单回信、邮件回信）让提供方回答。
      if (!wait.token.startsWith(SESSION_WAIT_PREFIX)) return undefined
      const sessions = ports.sessions as DshSessionPort
      const verdict = await sessions.probe(wait.token.slice(SESSION_WAIT_PREFIX.length))
      return {
        ready: verdict.ready,
        ...(verdict.ready
          ? {
              payload: {
                sessionId: wait.token.slice(SESSION_WAIT_PREFIX.length),
                ...(verdict.status === undefined ? {} : { status: verdict.status }),
              },
            }
          : {}),
      }
    },
    vocabulary: {
      // 本连接器不提供条件：它的规则只能靠空 when 匹配，动作才是它的事。
      normalizeCondition: () => undefined,
      normalizeAction: normalizeDshAction,
    },
    defaultRules: '',
  }
}
