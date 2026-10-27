/**
 * 规则文件在邮件这一侧的入口：把内核的解析器与邮件词表绑在一起。
 *
 * 解析、版本检查、注释保留的定向修改都在 `@free-lzj/dsh-decision` 里；这里只有
 * **一行绑定**，目的是让装配处与测试继续用原来的名字，不必认识那两个新参数。
 *
 * @module @free-lzj/dsh-mail/triage/rules
 */

import {
  loadRuleFile, parseRuleFile, RULES_VERSION, setActionMode, setRuleEnabled, swapPriority,
  type EditResult, type LoadedRules, type RuleFileError,
} from '@free-lzj/dsh-decision'
import { MAIL_VOCABULARY } from './config.ts'
import type { Rule } from './types.ts'

export { RULES_VERSION, setActionMode, setRuleEnabled, swapPriority }
export type { EditResult, LoadedRules, RuleFileError }

/**
 * 把一份规则文件的文本解析成规则。
 * @param source - 文件全文。
 * @returns 解析结果；失败时 `error.line` 有值就能指到行。
 */
export function parseRules(
  source: string,
): { ok: true; rules: readonly Rule[]; dropped: readonly string[] } | { ok: false; error: RuleFileError } {
  return parseRuleFile(source, MAIL_VOCABULARY)
}

/**
 * 读规则文件；不存在就用发货的默认规则并把它写出去。
 * @param path - 用户的规则文件路径。
 * @param fallback - 规则文件不存在时用的发货默认内容。
 * @returns 加载结果。
 */
export async function loadRules(path: string, fallback: string): Promise<LoadedRules<never, never>> {
  return await loadRuleFile(path, fallback, MAIL_VOCABULARY) as LoadedRules<never, never>
}
