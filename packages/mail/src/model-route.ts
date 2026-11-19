/**
 * 把配置里的 `provider/model` 拆成宿主 `ctx.llm.prepareCall` 认的**路由对象**。
 *
 * 宿主只认 `{ provider, model }`：把整串 `exe/deepseek-xxx` 直接当 `model` 传过去，
 * 它会解析出 `provider: undefined`，报「no adapter registered for provider "undefined"」——
 * 那句错看不出是配置写歪还是代码少拆了一步，所以拆解与报错都收在这里一处。
 *
 * 抽成独立模块是为了避开 `connector.ts ↔ nodes.ts` 的循环：两边都要用，谁也不该引对方。
 *
 * @module @free-lzj/dsh-mail/model-route
 */

/** 一条模型路由。 */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/**
 * 把 `provider/model` 拆成路由。
 * @param named - 配置里写的模型名。
 * @returns 路由；没有斜杠、斜杠在两端时返回 undefined（写歪了）。
 */
export function routeOf(named: string): ModelRoute | undefined {
  const trimmed = named.trim()
  const at = trimmed.indexOf('/')
  return at <= 0 || at === trimmed.length - 1
    ? undefined
    : { provider: trimmed.slice(0, at), model: trimmed.slice(at + 1) }
}
