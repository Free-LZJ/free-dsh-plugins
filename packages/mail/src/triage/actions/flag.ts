/**
 * 加星标。
 *
 * 与「标记已读」分开成文件而不是合成一个「改标志位」动作：它们在规则里是两件
 * 不同的事（星标是「我要回头看」，已读是「我看过了」），合并会让规则文件里
 * 出现 `flags: ['\\Flagged']` 这种把 IMAP 细节漏给用户的写法。
 *
 * @module @free-lzj/dsh-mail/triage/actions/flag
 */

import type { Action, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** 星标动作的实现；撤销即取消星标。 */
export const flagAction: Action = {
  kind: 'flag',
  sideEffect: true,
  async run(_spec, context): Promise<ActionOutcome> {
    const mail = context.mail
    if (mail === undefined) return failure('未安装邮件插件（@free-lzj/dsh-mail），无法改动邮件状态')
    const { accountId, summary } = context.task
    const result = await mail.applyAction({ op: 'flag', accountId, folder: summary.folder, uids: [summary.uid] })
    if (!result.ok) return failure(`加星标失败：${result.message}`)
    return {
      ok: true,
      detail: '已加星标',
      undo: async () => {
        const undone = await mail.applyAction({ op: 'unflag', accountId, folder: summary.folder, uids: [summary.uid] })
        if (!undone.ok) context.log(`[mail 分诊] 撤销加星标失败：${undone.message}`)
      },
    }
  },
}
