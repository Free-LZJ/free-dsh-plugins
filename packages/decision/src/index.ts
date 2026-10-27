/**
 * 决策内核：规则、命中记录与撤销窗口，**不认识任何来源**。
 *
 * 这不是插件——没有 `apply`、没有 Loader 行、没有浏览器半边。连接器（邮件、Jira、
 * 钉钉）依赖它，把自己的事件形状与专有动作注册进来；内核只提供「按规则判断」和
 * 「记下做过什么」这两件事的骨。
 *
 * @module @free-lzj/dsh-decision
 */

export * from './actions/http.ts'
export * from './actions/mcp.ts'
export * from './actions/notify.ts'
export * from './actions/script.ts'
export * from './config.ts'
export * from './pending.ts'
export * from './registry.ts'
export * from './rules.ts'
export * from './runs.ts'
export * from './store.ts'
export * from './types.ts'
