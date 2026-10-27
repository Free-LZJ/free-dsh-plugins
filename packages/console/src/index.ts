/**
 * Workbench for DSH — Host half.
 *
 * This is the wiring. It owns the long-lived things a home surface needs — the
 * `ctx.console` service other plugins talk to, the set of notification channels,
 * and the routes an open workbench polls and streams — and hands the rest to
 * modules that do not know about each other.
 *
 * The file is one of the workbench's extension points: a companion plugin that
 * registers another notification channel plugs into
 * `ctx.get('console').channels` the same way this file's own channels do, and
 * never edits this file.
 *
 * It deliberately does **not** enumerate the profile's plugins. The home list is
 * the workbench's own panels, and a panel exists only when its plugin declares
 * one through the console contract — so the list is the browser's to render from
 * the descriptors it was handed, and this half keeps two id lists about it.
 *
 * @module @free-lzj/dsh-console
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event merge.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the `ctx.webServer` service merge the routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerBuiltinChannels, type PageSurfaces } from './builtin-channels.ts'
import { STATE_DIR } from './store.ts'
import { ConsoleHost } from './console-host.ts'
import { BUILTIN_CHANNELS, type ConsoleLayout, type RunningSession } from './protocol.ts'
import { registerRoutes, type RouteHost } from './routes.ts'
import { registerAgentTools } from './tools.ts'
import { WorkbenchBoard } from './workbench/board.ts'
import { ClassifierRegistry, RULE_CLASSIFIER_ID, RuleClassifier } from './workbench/classifier.ts'
import { builtinConnectors, ConnectorRegistry } from './workbench/connectors.ts'
import { ExecutorRegistry, SimulatedExecutor } from './workbench/executors.ts'
import {
  createHarnessRunner, type SessionControllerLike, type WorkspaceRegistryLike,
} from './workbench/harness-session.ts'
import { RealSessionExecutor } from './workbench/real-session.ts'
import { defaultRoutingTable, RoutingTableStore } from './workbench/routing.ts'
import { registerWorkbenchRoutes } from './workbench/routes.ts'

export { ConsoleHost } from './console-host.ts'
export type { ConsoleEvent, ConsoleHostOptions } from './console-host.ts'
export { ChannelRegistry } from './channels.ts'
export type { DispatchResult, NoticeDelivery, NotificationChannel } from './channels.ts'
export { PresenceGate, registerBuiltinChannels } from './builtin-channels.ts'
export type { BuiltinChannelWiring, PageSurfaces } from './builtin-channels.ts'
export * from './paths.ts'
export * from './protocol.ts'
export { STATE_DIR }
export type { ConsolePrefs } from './store.ts'
export { WorkbenchBoard } from './workbench/board.ts'
export type { ActionResult, IngestResult, WorkbenchBoardOptions } from './workbench/board.ts'
export { ClassifierRegistry, RULE_CLASSIFIER_ID, RuleClassifier } from './workbench/classifier.ts'
export type { Classifier } from './workbench/classifier.ts'
export { builtinConnectors, ConnectorRegistry } from './workbench/connectors.ts'
export type { Connector } from './workbench/connectors.ts'
export { ExecutorRegistry, SimulatedExecutor } from './workbench/executors.ts'
export type { Executor, ExecutorHandle, SessionSink } from './workbench/executors.ts'
export { defaultRoutingTable, RoutingTableStore } from './workbench/routing.ts'
export type { RouteRule, RoutingTable } from './workbench/routing.ts'

// Type-only: the `ctx.console` service every adopting plugin injects.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The workbench Host service. One kind of plugin meets here: an adopting
     * panel declares itself in its browser half, every plugin may notify.
     */
    console: ConsoleHost
  }
}

/** Channel ids accepted by the configuration, in the settings row's order. */
const CHANNEL_IDS = [...BUILTIN_CHANNELS]

/** Connector ids accepted by the configuration, in the board's list order. */
const CONNECTOR_IDS = builtinConnectors().map((connector) => connector.id)

/** Configuration as written by a user, before the schema resolves defaults. */
type ConfigInput = {
  channels?: string[]
  layout?: ConsoleLayout
  workbenchConnectors?: string[]
  workbenchClassifier?: string
  workbenchWorkspace?: string
}

/** Live workbench configuration, resolved by the Loader row. */
export interface Config {
  /** Notification channels the dispatcher runs, in selection order. */
  channels: string[]
  /** View the home list opens with. */
  layout: ConsoleLayout
  /** Board connectors switched on; an id nobody implements is dropped with a warning. */
  workbenchConnectors: string[]
  /** Classifier id the board routes with; an unknown id falls back to the rule classifier. */
  workbenchClassifier: string
  /** Directory real runs happen in; empty means the real executor is not registered. */
  workbenchWorkspace: string
}

export const Config = Schema.object({
  channels: Schema.array(Schema.union(CHANNEL_IDS.map((id) => Schema.const(id))))
    .default([...CHANNEL_IDS])
    .description('Notification channels the workbench delivers through.'),
  layout: Schema.union(['grid', 'list', 'compact'] as const)
    .default('grid')
    .description('View the home list opens with.'),
  workbenchConnectors: Schema.array(Schema.union(CONNECTOR_IDS.map((id) => Schema.const(id))))
    .default(['mail', 'webhook'])
    .description('Board connectors switched on (mail and webhook work in v0; dingtalk and jira are placeholders).'),
  workbenchClassifier: Schema.string()
    .default(RULE_CLASSIFIER_ID)
    .description('Classifier id the board routes with.'),
  workbenchWorkspace: Schema.string()
    .default('')
    .description('Directory real sessions run in; empty keeps the board on the simulated executors.'),
}) as Schema<ConfigInput, Config>

/**
 * Mount the workbench.
 * @param ctx - the Host plugin context.
 * @param config - the Loader row configuration, live for its whole lifetime.
 */
export function apply(ctx: Context, config: Config): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const host = new ConsoleHost(ctx, {
    homeDir: home,
    channels: () => config.channels,
    layout: () => config.layout,
    runningSessions: async () => await readRunningSessions(ctx),
  })

  /**
   * The consequences a *page* performs: the Web Notification and the tone exist
   * only in the browser. Listed here as "unavailable" because this half cannot
   * raise them — the browser asks for the enabled channels and performs them
   * itself, so a channel that needs a page is gated by {@link ConsoleHost.presence}
   * rather than by these.
   */
  const pages: PageSurfaces = {
    raise: () => Promise.resolve(false),
    chime: () => false,
  }
  registerBuiltinChannels(host.channels, { gate: host.presence, pages })

  // The board's assembly: implementations register here, the board itself
  // never names one. A companion plugin adds an executor, a classifier, or a
  // connector by registering with the registries on its own mount, not by
  // editing this file — the same extension shape as the notification channels.
  const classifiers = new ClassifierRegistry()
  classifiers.register(new RuleClassifier())
  const executors = new ExecutorRegistry()
  executors.register(new SimulatedExecutor('dsh', 'DSH（模拟）'))
  executors.register(new SimulatedExecutor('codex', 'Codex（模拟）'))
  // 真实会话执行器：等会话服务真的就位之后才注册。
  //
  // 不能在这里直接 `ctx.get('sessionController')`：服务的挂载顺序不由本插件决定，
  // 早读一次只会拿到 undefined。`inject` 会等它出现（服务重启后还会再触发）。
  //
  // **实测结论（harness 0.2.x，2026-10）**：宿主里有 `sessions` 与 `agents`，**没有**
  // `sessionController` / `workspaceRegistry`，这两个名字因此永远等不到——真实执行器
  // 也就永远不会注册（比注册一个假装能跑的实现好，但仍是待修的）。它们的 API 在服务
  // 原型上（`Object.keys` 只能看到 store/projections 这类字段），要等 P2 把真正的
  // 建会话入口摸清再改这里；这个包和 mail 的会话端口都受同一问题影响。
  let realRegistered = false
  ctx.inject(['sessionController'], (inner) => {
    if (realRegistered) return
    const controller = inner.get('sessionController') as SessionControllerLike | undefined
    if (controller === undefined) return
    const workspaces = inner.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    const runner = createHarnessRunner({
      controller,
      ...(workspaces === undefined ? {} : { workspaces }),
      cwd: config.workbenchWorkspace,
      subscribe: (listener) => inner.on('session/event', listener),
      log: (line) => {
        inner.logger.warn(line)
      },
    })
    if (runner === undefined) {
      inner.logger.info(`console: real executor off (workspace: ${config.workbenchWorkspace === '' ? '<empty>' : config.workbenchWorkspace})`)
      return
    }
    executors.register(new RealSessionExecutor(runner))
    realRegistered = true
    inner.logger.info(`console: real executor on (workspace: ${config.workbenchWorkspace})`)
  })
  const connectors = new ConnectorRegistry()
  for (const connector of builtinConnectors()) connectors.register(connector)
  const routing = new RoutingTableStore(join(home, STATE_DIR, 'routing.json'), defaultRoutingTable(), (line) => {
    ctx.logger.warn(line)
  })
  // A user finds an editable routing document instead of an absent one; a
  // failure only means the built-in table keeps serving.
  void routing.ensureFile(defaultRoutingTable())
  const board = new WorkbenchBoard({
    homeDir: home,
    classifiers,
    executors,
    connectors,
    routing,
    enabledConnectors: () => config.workbenchConnectors,
    classifierId: () => config.workbenchClassifier,
    warn: (line) => {
      ctx.logger.warn(line)
    },
  })
  host.attachWorkbench(board)
  registerWorkbenchRoutes(ctx, { board })
  // 卸载时把最后一次写等完再走：写是合并的（一次写 + 一次补写），如果这一层不先生效，
  // 插件热重载/停用时最后那次改动就可能只留在内存里。
  ctx.effect(() => () => { void board.flush() }, 'console: flush the board on unload')

  // The Loader row can be re-applied live; reflect the new view preference
  // without a restart.
  ctx.on('loader/volatile-update', () => {
    host.applyConfig(config.layout)
  })

  const routeHost: RouteHost = {
    console: host,
    state: () => host.state(),
    setChannels: (channels) => {
      // An id this deployment does not implement (a channel removed by an
      // upgrade) is dropped with a warning rather than rejected: the saved
      // selection must stay usable across versions.
      const known = channels.filter((id) => {
        if (host.channels.get(id) !== undefined) return true
        ctx.logger.warn(`console: ignoring unknown notification channel "${id}"`)
        return false
      })
      if (known.length === 0) throw new Error('at least one notification channel must stay enabled')
      // `channels` is a plain schema field: the dispatcher reads it per notice,
      // so the next one already follows the new selection.
      config.channels = known
      host.changed()
      return Promise.resolve()
    },
    setLayout: async (layout) => {
      host.applyConfig(layout)
    },
    setView: async (view) => {
      await host.setView(view)
    },
  }

  registerRoutes(ctx, routeHost)

  // 工具注册表可能比本插件晚挂载（Loader 行的顺序由用户的 profile 决定），所以跟随它
  // 出现，而不是在 apply 时判断一次就放弃（`rules/design-patterns.md`）。
  ctx.inject(['tools'], (inner) => {
    inner.effect(() => registerAgentTools(inner, host), 'console: agent tools')
  })

  ctx.logger.info(`console: workbench mounted (channels: ${host.channels.list().map((channel) => channel.id).join(', ')})`)
  ctx.logger.info(`console: board mounted (connectors: ${connectors.list().map((connector) => connector.id).join(', ')})`)
}

/** 会话服务里「列出会话」那一半（与驱动会话的 {@link SessionControllerLike} 分开）。 */
interface SessionListLike {
  list?(request?: unknown, signal?: unknown): Promise<{
    readonly items?: readonly {
      readonly sessionId?: string
      readonly running?: boolean
      readonly cwd?: string
      readonly projections?: { readonly values?: { readonly title?: string } }
    }[]
  }>
}

/**
 * 现在有哪些会话在干活。
 *
 * 结构化声明而不是 import 会话控制器的类型：那是**可选**依赖——没挂它的部署只是首页
 * 少一块，不该因此起不来（`rules/design-patterns.md`）。
 * @param ctx - Host 上下文。
 * @returns 正在运行的会话；读不到时给空数组。
 */
async function readRunningSessions(ctx: Context): Promise<readonly RunningSession[]> {
  const controller = ctx.get('sessionController') as SessionListLike | undefined
  if (controller?.list === undefined) return []
  const page = await controller.list({})
  return (page.items ?? [])
    .filter(item => item.running === true && typeof item.sessionId === 'string')
    .map(item => ({
      sessionId: item.sessionId as string,
      title: item.projections?.values?.title?.trim() ?? '',
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    }))
}
