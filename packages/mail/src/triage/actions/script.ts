/**
 * 跑一个外部命令 —— 现在只是**内核实现的邮件适配**。
 *
 * 参数不过 shell、只替换投影里的值、退出码带输出、截断加省略号，全都在
 * `@free-lzj/dsh-decision` 的 `runScript` 里。这里只剩投影与结果形状的转换。
 *
 * 默认三态是 `suggest`：跑出去的命令收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/script
 */

import { fillArgs as fillArgsOf, runScript } from '@free-lzj/dsh-decision'
import type { Action, ActionContext, ActionOutcome } from './context.ts'
/**
 * 把投影里的值填进参数里的占位符。
 *
 * 保留这个导出是因为别处（规则页的预览）也想要同一个函数；实现只有内核那一份。
 * @param args - 规则里写的参数。
 * @param context - 动作上下文。
 * @returns 替换后的参数。
 */
export function fillArgs(args: readonly string[], context: ActionContext): readonly string[] {
  return fillArgsOf(args, context.templateValues)
}

/** 脚本动作。 */
export const scriptAction: Action = {
  kind: 'script',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const outcome = await runScript(
      {
        ...(spec.command === undefined ? {} : { command: spec.command }),
        ...(spec.args === undefined ? {} : { args: spec.args }),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      },
      {
        templateValues: context.templateValues,
        ...(context.subprocess === undefined ? {} : { subprocess: context.subprocess }),
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : { ok: false, detail: outcome.message }
  },
}