/**
 * 调一个 MCP 工具。
 *
 * 工具名用宿主给的全名（`mcp__<server>__<tool>`），因为那是模型与插件共同的语言：
 * 规则文件里写 `mcp__jira__get_issue` 与 agent 在会话里调的是同一个东西，用户不必
 * 学第二套命名。
 *
 * 入参里的占位符只支持**头部字段与邮件身份**，不支持正文——与 `script` 同理。
 * 默认三态是 `suggest`：一个 MCP 写操作收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/mcp
 */

import { fillTemplate } from '../repo.ts'
import type { Action, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/**
 * 递归替换入参里的字符串占位符。
 *
 * 递归而不是只看顶层：真实工具入参常常是嵌套的（`{ filter: { key: '{subject}' } }`）。
 * 对象与数组结构原样保留，只改字符串叶子。
 * @param value - 原始入参。
 * @param values - 可替换的值。
 * @returns 替换后的入参。
 */
export function fillInput(value: unknown, values: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return fillTemplate(value, values)
  if (Array.isArray(value)) return value.map(item => fillInput(item, values))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fillInput(inner, values)]))
  }
  return value
}

/** MCP 动作。 */
export const mcpAction: Action = {
  kind: 'mcp',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const tools = context.tools
    if (tools === undefined) return failure('未挂载工具服务，无法调用 MCP 工具')
    if (spec.tool === undefined) return failure('这条 mcp 动作没有写 tool')
    const { summary, rule } = context.task
    const input = fillInput(spec.input ?? {}, {
      ...context.vars,
      subject: summary.subject,
      from: summary.from.address,
      rule: rule.name,
      account: context.task.accountName,
      uid: String(summary.uid),
    })
    try {
      await tools.call(spec.tool, input as Readonly<Record<string, unknown>>)
    } catch (error: unknown) {
      return failure(`调用 ${spec.tool} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, detail: `已调用 ${spec.tool}` }
  },
}
