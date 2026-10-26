/**
 * 标记已读。
 *
 * 之所以把这个小动作单独成文件：它是「推广邮件自动处理掉」这条需求的最小一半，
 * 也是撤销窗口最典型的用户——标错了可以标回去。
 *
 * @module @free-lzj/dsh-mail/triage/actions/mark-read
 */

import type { Action, ActionContext, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** 一个 UID 的批量动作；`op` 决定加还是减标志位。 */
async function setSeen(context: ActionContext, op: 'markRead' | 'markUnread'): Promise<ActionOutcome> {
  const mail = context.mail
  if (mail === undefined) return failure('未安装邮件插件（@free-lzj/dsh-mail），无法改动邮件状态')
  const { accountId, summary } = context.task
  const result = await mail.applyAction({ op, accountId, folder: summary.folder, uids: [summary.uid] })
  if (!result.ok) return failure(`标记失败：${result.message}`)
  const back = op === 'markRead' ? 'markUnread' : 'markRead'
  return {
    ok: true,
    detail: op === 'markRead' ? '已标记为已读' : '已标记为未读',
    undo: async () => {
      // 撤销失败只记日志：它不该把「这条记录已经撤销过」这件事变成一次新的失败。
      const undone = await mail.applyAction({ op: back, accountId, folder: summary.folder, uids: [summary.uid] })
      if (!undone.ok) context.log(`[mail 分诊] 撤销「${op}」失败：${undone.message}`)
    },
  }
}

/** 标记已读；撤销即标回未读。 */
export const markReadAction: Action = {
  kind: 'markRead',
  sideEffect: true,
  run: (_spec, context) => setSeen(context, 'markRead'),
}
