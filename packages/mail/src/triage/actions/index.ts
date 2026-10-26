/**
 * 本部署发货的全部动作实现。
 *
 * 与 `src/conditions.ts` 的 `builtinConditions()` 同一个用意：把「装了哪些动作」
 * 集中成一处，装配处只调这一个函数。新增一个动作 = 新增一个文件 + 在这里加一行，
 * 内核（`src/registry.ts`）不动。
 *
 * @module @free-lzj/dsh-mail/triage/actions
 */

import { archiveAction } from './archive.ts'
import type { Action } from './context.ts'
import { flagAction } from './flag.ts'
import { followupAction } from './followup.ts'
import { httpAction } from './http.ts'
import { markReadAction } from './mark-read.ts'
import { mcpAction } from './mcp.ts'
import { moveAction } from './move.ts'
import { notifyAction } from './notify.ts'
import { scriptAction } from './script.ts'
import { sessionAction } from './session.ts'

export * from './context.ts'
export { moveTo } from './move.ts'
export { renderTitle } from './notify.ts'
export { fillArgs } from './script.ts'
export { fillInput } from './mcp.ts'
export { renderMailPrompt, renderFollowupPrompt, resolveWorkspace, UNTRUSTED_NOTICE } from './session.ts'
export { archiveAction } from './archive.ts'
export { flagAction } from './flag.ts'
export { followupAction } from './followup.ts'
export { httpAction } from './http.ts'
export { markReadAction } from './mark-read.ts'
export { mcpAction } from './mcp.ts'
export { moveAction } from './move.ts'
export { notifyAction } from './notify.ts'
export { scriptAction } from './script.ts'
export { sessionAction } from './session.ts'

/**
 * 全部内置动作，按注册顺序。
 * @returns 十个动作实现。
 */
export function builtinActions(): readonly Action[] {
  return [
    markReadAction,
    flagAction,
    moveAction,
    archiveAction,
    notifyAction,
    sessionAction,
    followupAction,
    scriptAction,
    mcpAction,
    httpAction,
  ]
}
