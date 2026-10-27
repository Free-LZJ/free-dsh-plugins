/**
 * 推一条工作台通知 —— 现在只是**内核实现的邮件适配**。
 *
 * 渲染、兜底、错误处理都在 `@free-lzj/dsh-decision` 的 `runNotify` 里：那一版只认模板值与
 * 一个投递端口，不认识邮件。这里保留三件事：
 *
 * 1. 邮件模板里常用的键（`{subject}` / `{from}` / `{rule}` / `{date}` / `{account}`）由
 *    `ActionContext.templateValues` 提供，映射不在这份文件里；
 * 2. **默认标题用全角冒号**（`{rule}：{subject}`），因为它是中文界面上的句子；
 * 3. `ActionOutcome` 的形状转换。
 *
 * @module @free-lzj/dsh-mail/triage/actions/notify
 */

import { renderNotifyTitle, runNotify } from '@free-lzj/dsh-decision'
import type { Action, ActionContext, ActionOutcome } from './context.ts'

/** 缺省标题：说清是哪条规则、对哪封邮件。 */
const DEFAULT_TITLE = '{rule}：{subject}'

/**
 * 渲染通知标题。
 * @param spec - 动作配置。
 * @param context - 动作上下文。
 * @returns 一行标题。
 */
export function renderTitle(spec: { readonly title?: string }, context: ActionContext): string {
  return renderNotifyTitle(
    { title: spec.title ?? DEFAULT_TITLE },
    { templateValues: context.templateValues, source: 'mail', log: context.log },
  )
}

/** 通知动作；不改变外部世界，所以不进撤销窗口。 */
export const notifyAction: Action = {
  kind: 'notify',
  sideEffect: false,
  async run(spec, context): Promise<ActionOutcome> {
    const outcome = await runNotify(
      { ...spec, title: spec.title ?? DEFAULT_TITLE },
      {
        templateValues: context.templateValues,
        ...(context.console === undefined ? {} : { console: context.console }),
        source: 'mail',
        log: context.log,
      },
    )
    // 内核的回答是 {ok:false, message}，这一侧的习惯是 {ok:false, detail}——转换放在这里。
    return outcome.ok ? { ok: true, detail: outcome.detail } : { ok: false, detail: outcome.message }
  },
}
