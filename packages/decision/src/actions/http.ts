/**
 * The HTTP action, in the kernel.
 *
 * The kernel sends a **body the connector already built**. That is the whole point of
 * the split: an HTTP payload is connector-shaped (a mail posts its headers, a Jira
 * connector would post fields), and teaching the kernel those field names would make
 * every connector's shape a kernel concern. So the contract here is deliberately
 * narrow — URL, method, body — and the connector keeps ownership of what a payload
 * looks like.
 *
 * Two behaviours are carried over: a non-2xx answer is a **failure with the status**,
 * not a silent success; and the body is always JSON, because that is the only shape
 * this action promises.
 *
 * @module @free-lzj/dsh-decision/actions/http
 */

import type { ActionResult } from '../registry.ts'

/** The fetch capability, as far as this action needs it. */
export type HttpPort = (
  url: string,
  init: {
    readonly method: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  },
) => Promise<{ readonly ok: boolean; readonly status: number }>

/** One HTTP action's configuration. */
export interface HttpSpec {
  readonly url?: string
  readonly method?: string
}

/** What one request needs. */
export interface HttpContext {
  readonly fetch?: HttpPort
  /** The body to post, already built by the connector. */
  readonly payload: unknown
}

/**
 * Run the HTTP action.
 * @param spec - where to send and how.
 * @param context - the fetch port and the prepared payload.
 * @returns whether the other side accepted it.
 */
export async function runHttp(spec: HttpSpec, context: HttpContext): Promise<ActionResult> {
  const send = context.fetch
  if (send === undefined) return { ok: false, message: '未挂载 HTTP 能力，无法发送请求' }
  if (spec.url === undefined || spec.url === '') return { ok: false, message: '这条 http 动作没有写 url' }
  let body: string
  try {
    body = JSON.stringify(context.payload)
  } catch (error: unknown) {
    return { ok: false, message: `请求体无法序列化：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const response = await send(spec.url, {
      method: spec.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    // 2xx 之外的应答都是失败：把 200 之外的「其实没成功」当成功，规则会在无人察觉时失效。
    if (!response.ok) return { ok: false, message: `HTTP ${String(response.status)}（${spec.url}）` }
  } catch (error: unknown) {
    return { ok: false, message: `发送请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, detail: `已发送到 ${spec.url}` }
}
