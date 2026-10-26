/**
 * 把邮件投递到一个**已经存在**的会话里。
 *
 * 与 `session` 动作的差别只有一处：那边每封邮件开一个新会话，这边复用同一个常驻
 * 会话。适合「先攒着、需要时一起看」的用法——比如一个邮箱助手会话，新邮件都进去，
 * 由它在你问的时候汇总。
 *
 * 两条取舍：
 *
 * 1. **不新建会话**。会话 id 写错就失败并说明，绝不偷偷新建一个：那样用户会得到
 *    一堆他不知道存在的会话，而他配这个动作的意图恰恰是「都进那一个」。
 * 2. **默认要撤销窗口**（`sideEffect: true`）。投递进去 agent 就开始干活了，给两分钟
 *    后悔时间是合理的；想立刻投递就在规则里写 `delaySeconds: 0`——但注意排队重放时
 *    手上没有正文，走这条路时正文为空。所以「立刻投递」才是它该有的配置。
 *
 * @module @free-lzj/dsh-mail/triage/actions/followup
 */

import { renderFollowupPrompt } from './session.ts'
import type { Action, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** 投递动作：把邮件正文投进一个已有会话。 */
export const followupAction: Action = {
  kind: 'followup',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const sessions = context.sessions
    if (sessions === undefined) {
      return failure('未挂载会话服务，无法投递到已有会话（需要 sessionController）')
    }
    const sessionId = spec.sessionId
    if (sessionId === undefined || sessionId.trim() === '') {
      return failure('followup 动作缺少 sessionId：投递到已有会话必须写明目标会话')
    }
    const { summary, rule } = context.task
    try {
      await sessions.followup(sessionId, renderFollowupPrompt(context, spec.instructions), {
        kind: 'plugin:dsh-mail',
        form: 'mail',
        ruleId: rule.id,
        accountId: context.task.accountId,
        folder: summary.folder,
        uid: summary.uid,
        uidValidity: summary.uidValidity,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // 会话不存在是最常见的失败：宿主在 resolveAgent 里给出错误，这里原样带出来。
      return failure(`投递到会话 ${sessionId} 失败：${message}`)
    }
    return { ok: true, detail: `已投递到会话 ${sessionId}`, sessionId }
  },
}
