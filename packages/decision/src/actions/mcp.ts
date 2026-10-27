/**
 * The MCP action, in the kernel.
 *
 * The tool name is the host's full name (`mcp__<server>__<tool>`): it is the one
 * vocabulary the model and the plugin already share, so a rule file and a session
 * call the same thing. That is why this action needs **nothing but a tool name, an
 * input tree, and the projection** — which is what makes it a kernel action rather
 * than a connector one.
 *
 * Placeholders are filled through the whole input tree, not just the top level:
 * real tool schemas nest (`{ filter: { key: '{subject}' } }`), and a top-level-only
 * fill would silently send the literal `{subject}` to a server.
 *
 * @module @free-lzj/dsh-decision/actions/mcp
 */

import { fillTemplate, type ActionResult, type TemplateValues } from '../registry.ts'

/** The tool service, as far as this action needs it. */
export interface ToolPort {
  call(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** One MCP action's configuration. */
export interface McpSpec {
  readonly tool?: string
  readonly input?: Readonly<Record<string, unknown>>
}

/** What one MCP call needs. */
export interface McpContext {
  readonly templateValues: TemplateValues
  readonly tools?: ToolPort
}

/**
 * Replace placeholders through an input tree.
 *
 * Structure is preserved; only string leaves change. Non-string leaves (numbers,
 * booleans, null) pass through untouched — a tool schema that wants `limit: 10`
 * must not receive `"10"`.
 * @param value - the configured input.
 * @param values - the projection.
 * @returns a filled copy.
 */
export function fillInput(value: unknown, values: TemplateValues): unknown {
  if (typeof value === 'string') return fillTemplate(value, values)
  if (Array.isArray(value)) return value.map(item => fillInput(item, values))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, fillInput(inner, values)]),
    )
  }
  return value
}

/**
 * Run the MCP action.
 * @param spec - the tool and its configured input.
 * @param context - the projection and the tool service.
 * @returns whether the call went through, with the tool's name either way.
 */
export async function runMcp(spec: McpSpec, context: McpContext): Promise<ActionResult> {
  const tools = context.tools
  if (tools === undefined) return { ok: false, message: '未挂载工具服务，无法调用 MCP 工具' }
  if (spec.tool === undefined || spec.tool === '') return { ok: false, message: '这条 mcp 动作没有写 tool' }
  const input = fillInput(spec.input ?? {}, context.templateValues) as Readonly<Record<string, unknown>>
  try {
    await tools.call(spec.tool, input)
  } catch (error: unknown) {
    return { ok: false, message: `调用 ${spec.tool} 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, detail: `已调用 ${spec.tool}` }
}
