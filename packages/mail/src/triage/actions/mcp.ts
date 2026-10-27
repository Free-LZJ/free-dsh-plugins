/**
 * 调一个 MCP 工具 —— 现在只是**内核实现的邮件适配**。
 *
 * 递归填占位符、失败折成结果、非字符串叶子原样保留，全都在 `@free-lzj/dsh-decision`
 * 的 `runMcp` 里。这里只剩两件事：把邮件的投影与工具服务交给内核、把 `ActionResult`
 * 转成这一侧习惯的 `ActionOutcome`。
 *
 * 工具名用宿主给的全名（`mcp__<server>__<tool>`）：那是模型与插件共同的语言，规则文件里
 * 写 `mcp__jira__get_issue` 与 agent 在会话里调的是同一个东西。
 *
 * 默认三态是 `suggest`：一个 MCP 写操作收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/mcp
 */

import { fillInput as fillInputOf, runMcp } from '@free-lzj/dsh-decision'
import type { Action, ActionOutcome } from './context.ts'

/**
 * 递归替换入参里的字符串占位符（保留导出：别处用得到同一个函数，不该有两份实现）。
 * @param value - 原始入参。
 * @param values - 可替换的值。
 * @returns 替换后的入参。
 */
export const fillInput = fillInputOf

/** MCP 动作。 */
export const mcpAction: Action = {
  kind: 'mcp',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const outcome = await runMcp(
      {
        ...(spec.tool === undefined ? {} : { tool: spec.tool }),
        ...(spec.input === undefined ? {} : { input: spec.input }),
      },
      {
        templateValues: context.templateValues,
        ...(context.tools === undefined ? {} : { tools: context.tools }),
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : { ok: false, detail: outcome.message }
  },
}
