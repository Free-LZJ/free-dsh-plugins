/**
 * 推一条工作台通知。
 *
 * 这是 `suggest` 三态唯一的出口：动作不执行，只告诉人「我建议这么处理」。所以标题
 * 支持占位符（`{subject}`、`{from}`、`{rule}`），让那一条通知自己说清是哪封邮件、
 * 哪条规则建议的——一条写着「有新邮件」的通知等于没通知。
 *
 * @module @free-lzj/dsh-mail/triage/actions/notify
 */

import { fillTemplate } from '../repo.ts'
import type { Action, ActionContext, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** 缺省标题：说清是哪条规则、对哪封邮件。 */
const DEFAULT_TITLE = '{rule}：{subject}'

/**
 * 渲染通知标题。
 * @param spec - 动作配置。
 * @param context - 动作上下文。
 * @returns 一行标题。
 */
export function renderTitle(spec: { readonly title?: string }, context: ActionContext): string {
  const { summary, rule } = context.task
  const filled = fillTemplate(spec.title ?? DEFAULT_TITLE, {
    subject: summary.subject,
    from: summary.from.name ?? summary.from.address,
    rule: rule.name,
    date: summary.date,
    account: context.task.accountName,
  }).trim()
  return filled === '' ? `邮件：${summary.subject}` : filled
}

/** 通知动作；不需要撤销（它没有改变任何东西）。 */
export const notifyAction: Action = {
  kind: 'notify',
  sideEffect: false,
  async run(spec, context): Promise<ActionOutcome> {
    const workbench = context.console
    const title = renderTitle(spec, context)
    if (workbench === undefined) {
      // 没装工作台是正常部署，不是错误：记一行日志，动作算成立。
      context.log(`[mail 分诊] 未安装工作台，通知未送出：${title}`)
      return { ok: true, detail: `未安装工作台，通知未送出：${title}` }
    }
    try {
      // 纯通知走 `notify`；工作台若只提供条目接口（或 `notify` 被省略），退回 `raise`。
      if (workbench.notify !== undefined) {
        await workbench.notify({
          title,
          body: `${context.task.summary.from.address} · ${context.task.rule.name}`,
          tone: spec.tone ?? 'info',
          source: 'mail',
        })
      } else if (workbench.raise !== undefined) {
        await workbench.raise({
          title,
          body: `${context.task.summary.from.address} · ${context.task.rule.name}`,
          tone: spec.tone ?? 'info',
          source: 'mail',
          kind: 'mail',
          actions: [],
        })
      }
    } catch (error: unknown) {
      return failure(`推送通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, detail: `已通知：${title}` }
  },
}
