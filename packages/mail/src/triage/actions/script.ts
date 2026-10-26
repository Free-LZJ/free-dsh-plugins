/**
 * 跑一个外部命令。
 *
 * 两条硬规则，都是为了让它不至于变成注入通道：
 *
 * 1. **参数是数组，不经过 shell**。`args: ['-m', 'xyz']` 里的内容永远不会被当成
 *    命令解析，所以邮件正文里写 `; rm -rf /` 也没有东西去执行它。
 * 2. **邮件内容不进命令行**。占位符只在 `args` 里支持 `{subject}` 这类**头部字段**，
 *    不支持正文；真要把正文交给脚本，应当走「开会话」让 agent 判断。这条不是洁癖：
 *    脚本参数会出现在进程列表里，而正文是不可信内容。
 *
 * 默认三态是 `suggest`（见 `src/config.ts`），因为跑出去的命令收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/script
 */

import { fillTemplate } from '../repo.ts'
import type { Action, ActionContext, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** 输出截断：命中记录里只放摘要，完整输出没有存放它的地方。 */
const OUTPUT_LIMIT = 500

/**
 * 把头部字段填进参数里的占位符。
 * @param args - 规则里写的参数。
 * @param context - 动作上下文。
 * @returns 替换后的参数。
 */
export function fillArgs(args: readonly string[], context: ActionContext): readonly string[] {
  const { summary, rule } = context.task
  const values = {
    ...context.vars,
    subject: summary.subject,
    from: summary.from.address,
    folder: summary.folder,
    uid: String(summary.uid),
    rule: rule.name,
    account: context.task.accountName,
  }
  return args.map(arg => fillTemplate(arg, values))
}

/** 脚本动作。 */
export const scriptAction: Action = {
  kind: 'script',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const runner = context.subprocess
    if (runner === undefined) return failure('未挂载子进程能力，无法执行脚本')
    if (spec.command === undefined) return failure('这条 script 动作没有写 command')
    const args = fillArgs(spec.args ?? [], context)
    try {
      const result = await runner.spawn({
        command: spec.command,
        args,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      })
      if (result.code !== 0) {
        return failure(`脚本退出码 ${String(result.code)}：${firstLine(result.stderr) || firstLine(result.stdout)}`)
      }
      const summary = firstLine(result.stdout)
      return { ok: true, detail: summary === '' ? `${spec.command} 执行完成` : `${spec.command}：${summary}` }
    } catch (error: unknown) {
      return failure(`脚本执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/** 取输出的第一行并截断；空输出给空串。 */
function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length <= OUTPUT_LIMIT ? line : `${line.slice(0, OUTPUT_LIMIT)}…`
}
