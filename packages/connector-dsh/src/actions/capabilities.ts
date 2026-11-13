/**
 * 通用能力动作：通知、脚本、MCP、HTTP、大模型。
 *
 * 它们以前都长在邮件插件里，其实与邮件无关——只需要「一段投影 + 一个端口」。搬到这里
 * 之后，规则里写 `notify` 的服务方变成 DSH 连接器，而 **kind 保持原名**，所以旧规则
 * 文件不用改。
 *
 * 每个动作只做两件事：把投影交给内核的实现，把结果折成 {@link ActionOutcome}。
 * 真正的行为（模板填充、退出码、非 2xx、工具名）都在内核里，这里不复制一份。
 *
 * @module @free-lzj/dsh-connector-dsh/actions/capabilities
 */

import {
  defineAction, fillTemplate, runHttp, runMcp, runNotify, runScript,
} from '@free-lzj/dsh-decision'
import type { ActionNode, ActionOutcome, ActionSpecLike, TemplateValues, TaskContext } from '@free-lzj/dsh-decision'
import { failure, portsOf } from '../ports.ts'

/** 通知。 */
export interface NotifySpec extends ActionSpecLike {
  readonly title?: string
  readonly body?: string
  readonly tone?: 'info' | 'success' | 'warn' | 'error'
  readonly link?: string
}

/** 脚本。 */
export interface ScriptSpec extends ActionSpecLike {
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
}

/** MCP 工具。 */
export interface McpSpec extends ActionSpecLike {
  readonly tool?: string
  readonly input?: Readonly<Record<string, unknown>>
}

/** HTTP。 */
export interface HttpSpec extends ActionSpecLike {
  readonly url?: string
  readonly method?: string
}

/** 大模型调用。 */
export interface LlmSpec extends ActionSpecLike {
  /** 提示词模板；缺省用投影里的 `prompt`。 */
  readonly prompt?: string
  readonly system?: string
  /** `provider/model`；缺省用投影里的 `model`。 */
  readonly model?: string
  readonly maxTokens?: number
}

/** 投给通知与脚本的投影：`vars` 就是那一份字符串 map。 */
function projection(context: TaskContext): TemplateValues {
  return context.vars
}

/** 通知动作；不改变外部世界，所以不进撤销窗口。 */
export const notifyAction: ActionNode<NotifySpec, TaskContext> = defineAction({
  kind: 'notify',
  sideEffect: false,
  async run(spec, context): Promise<ActionOutcome> {
    const outcome = await runNotify(
      {
        ...(spec.title === undefined ? {} : { title: spec.title }),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        ...(spec.tone === undefined ? {} : { tone: spec.tone }),
        ...(spec.link === undefined ? {} : { link: spec.link }),
      },
      {
        templateValues: projection(context),
        ...(portsOf(context).console === undefined ? {} : { console: portsOf(context).console }),
        source: 'dsh',
        log: context.log,
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : failure(outcome.message)
  },
})

/** 脚本动作；默认有副作用。 */
export const scriptAction: ActionNode<ScriptSpec, TaskContext> = defineAction({
  kind: 'script',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const subprocess = portsOf(context).subprocess
    const outcome = await runScript(
      {
        ...(spec.command === undefined ? {} : { command: spec.command }),
        ...(spec.args === undefined ? {} : { args: spec.args }),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      },
      {
        templateValues: projection(context),
        ...(subprocess === undefined ? {} : { subprocess }),
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : failure(outcome.message)
  },
})

/** MCP 动作；写操作居多，默认有副作用。 */
export const mcpAction: ActionNode<McpSpec, TaskContext> = defineAction({
  kind: 'mcp',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const tools = portsOf(context).tools
    const outcome = await runMcp(
      {
        ...(spec.tool === undefined ? {} : { tool: spec.tool }),
        ...(spec.input === undefined ? {} : { input: spec.input }),
      },
      {
        templateValues: projection(context),
        ...(tools === undefined || tools.call === undefined ? {} : { tools: { call: async (name, input) => await tools.call?.(name, input) } }),
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : failure(outcome.message)
  },
})

/** HTTP 动作；请求发出去收不回来，默认有副作用。 */
export const httpAction: ActionNode<HttpSpec, TaskContext> = defineAction({
  kind: 'http',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const send = portsOf(context).fetch
    // 载荷就是投影：**不含正文**——正文是不可信内容，把它 POST 出去意味着任何能给这个
    // 来源写内容的人都能向那个服务写入任意东西。要传正文，先由会话里的 agent 判断。
    const outcome = await runHttp(
      {
        ...(spec.url === undefined ? {} : { url: spec.url }),
        ...(spec.method === undefined ? {} : { method: spec.method }),
      },
      {
        payload: projection(context),
        fetch: async (url, init) => {
          const response = await send(url, {
            method: init.method,
            ...(init.headers === undefined ? {} : { headers: init.headers }),
            ...(init.body === undefined ? {} : { body: init.body }),
          })
          return { ok: response.ok, status: response.status }
        },
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : failure(outcome.message)
  },
})

/** 把 `provider/model` 拆成路由；写错就返回 undefined。 */
export function modelRoute(named: string): { readonly provider: string; readonly model: string } | undefined {
  const trimmed = named.trim()
  const at = trimmed.indexOf('/')
  if (at <= 0 || at === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, at), model: trimmed.slice(at + 1) }
}

/** 大模型调用动作：一次请求、一段文本。 */
export const llmAction: ActionNode<LlmSpec, TaskContext> = defineAction({
  kind: 'llm',
  sideEffect: false,
  async run(spec, context): Promise<ActionOutcome> {
    const llm = portsOf(context).llm
    if (llm === undefined) return failure('未挂载 LLM 能力（ctx.llm），无法调用模型', 'config')
    const named = spec.model ?? context.vars['model'] ?? ''
    const route = modelRoute(named)
    if (route === undefined) return failure(`llm 动作的 model 必须是 provider/model：${named === '' ? '（空）' : named}`, 'config')
    const prompt = fillTemplate(spec.prompt ?? '{prompt}', projection(context)).trim()
    if (prompt === '') return failure('llm 动作没有可用的 prompt（规则没写，投影里也没有）', 'config')

    const controller = new AbortController()
    try {
      const call = await llm.prepareCall(
        { ...route, ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }) },
        controller.signal,
        current => current,
      )
      let text = ''
      for await (const chunk of call.stream({
        ...(typeof call.config === 'object' && call.config !== null ? call.config as object : {}),
        // 宿主的 `Message.content` 是块数组；字符串不会被拒，只会被当成空消息发出去。
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(spec.system === undefined ? {} : { system: spec.system }),
        purpose: 'workbench-llm',
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      const answer = text.trim()
      return {
        ok: true,
        detail: answer === '' ? '模型没有返回文本' : answer.slice(0, 200),
        data: { model: named, answer: answer.slice(0, 4000) },
      }
    } catch (error: unknown) {
      return failure(`调用模型失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
})

/** 全部通用能力动作，按注册顺序。 */
export function capabilityActions(): readonly ActionNode<ActionSpecLike, TaskContext>[] {
  return [notifyAction, scriptAction, mcpAction, httpAction, llmAction] as readonly ActionNode<ActionSpecLike, TaskContext>[]
}
