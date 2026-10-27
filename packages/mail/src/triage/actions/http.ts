/**
 * 发一个 HTTP 请求。
 *
 * 发出去的是**邮件元数据**（主题、发件人、规则名、账号、UID），**不含正文**。这不是
 * 省事：正文是不可信内容，把它 POST 到外部服务意味着任何一个能给这个邮箱发信的人
 * 都能向那个服务写入任意内容。真要传正文，应当先由 agent 在会话里判断。
 *
 * 默认三态是 `suggest`：请求发出去收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/http
 */

import { runHttp } from '@free-lzj/dsh-decision'
import type { Action, ActionOutcome } from './context.ts'

/**
 * 发出去的是**邮件元数据**（主题、发件人、规则名、账号、UID），**不含正文**。这不是
 * 省事：正文是不可信内容，把它 POST 到外部服务意味着任何一个能给这个邮箱发信的人
 * 都能向那个服务写入任意内容。真要传正文，应当先由 agent 在会话里判断。
 *
 * 投递与错误折叠在内核的 `runHttp` 里；**载荷的形状归这一侧**——那正是内核不该知道的
 * 东西（`docs/.../workbench-redesign-analysis.md` §10.5）。
 *
 * 默认三态是 `suggest`：请求发出去收不回来。
 *
 * @module @free-lzj/dsh-mail/triage/actions/http
 */

/** HTTP 动作。 */
export const httpAction: Action = {
  kind: 'http',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const { summary, rule, accountName, accountId } = context.task
    const payload = {
      rule: rule.name,
      account: accountName,
      accountId,
      folder: summary.folder,
      uid: summary.uid,
      from: summary.from,
      subject: summary.subject,
      date: summary.date,
      headers: summary.headers,
    }
    const outcome = await runHttp(
      {
        ...(spec.url === undefined ? {} : { url: spec.url }),
        ...(spec.method === undefined ? {} : { method: spec.method }),
      },
      {
        payload,
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      },
    )
    return outcome.ok ? { ok: true, detail: outcome.detail } : { ok: false, detail: outcome.message }
  },
}