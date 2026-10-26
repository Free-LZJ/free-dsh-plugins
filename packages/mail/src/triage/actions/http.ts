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

import type { Action, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/** HTTP 动作。 */
export const httpAction: Action = {
  kind: 'http',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const send = context.fetch
    if (send === undefined) return failure('未挂载 HTTP 能力，无法发送请求')
    if (spec.url === undefined) return failure('这条 http 动作没有写 url')
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
    try {
      const response = await send(spec.url, {
        method: spec.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) return failure(`HTTP ${String(response.status)}（${spec.url}）`)
    } catch (error: unknown) {
      return failure(`发送请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, detail: `已发送到 ${spec.url}` }
  },
}
