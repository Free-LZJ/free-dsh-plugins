/**
 * DSH 连接器 — 内置连接器。
 *
 * 它是**库**，不是插件：没有 Loader 行，也不进 DSH 插件目录。装工作台就有它，因为
 * 它提供的是宿主能力（建会话、投递、通知、脚本、MCP、HTTP、大模型），和工作台本身
 * 生命周期一致——把它们做成可选安装，只会让「工作台装好了但什么都不会做」变成一种
 * 常见状态。
 *
 * 它仍然是**普通连接器**：走 `ctx.console.tasks` 那套注册 API，一行特权代码都没有。
 * 这条是边界检验——把一个内置连接器搬出去，核心不用改。
 *
 * @module @free-lzj/dsh-connector-dsh
 */

export { createDshConnector, normalizeDshAction, toolTrigger, DSH_ACTIONS } from './connector.ts'
export type { DshConnectorOptions } from './connector.ts'
export { createDshPorts, createDshSessionPort } from './ports.ts'
export type { DshPorts, DshSessionPort, SessionControllerLike, WorkspaceRegistryLike } from './ports.ts'
