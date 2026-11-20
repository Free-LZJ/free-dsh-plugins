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
import { createDshConnector } from '@free-lzj/dsh-connector-dsh'
import { TaskEngine } from '@free-lzj/dsh-decision'
import { HANDED_TO_PAGE, registerBuiltinChannels } from './builtin-channels.ts'
import { STATE_DIR } from './store.ts'
import { ConsoleHost } from './console-host.ts'
import { BUILTIN_CHANNELS, type ConsoleLayout, type RunningSession } from './protocol.ts'
import { registerRoutes, type RouteHost } from './routes.ts'
import { registerTasksRoutes } from './tasks-routes.ts'
import { registerRulesRoutes, rulesHome } from './rules/index.ts'
import { registerAgentTools } from './tools.ts'
import {
  runningSessionsOf, titleOfSession, type HarnessAgentsLike, type SessionRecordLike, type SessionTitleReaderLike,
} from './workbench/harness-session.ts'
import { createWorkbenchSessionPort } from './workbench/session-port.ts'

export { ConsoleHost } from './console-host.ts'
export type { ConsoleEvent, ConsoleHostOptions } from './console-host.ts'
export { ChannelRegistry } from './channels.ts'
export type { DispatchResult, NoticeDelivery, NotificationChannel } from './channels.ts'
export { PresenceGate, registerBuiltinChannels } from './builtin-channels.ts'
export type { BuiltinChannelWiring, PageSurfaces } from './builtin-channels.ts'
export { registerRulesRoutes, rulesHome } from './rules/index.ts'
export type { RulesEngine, RulesRouteHost } from './rules/index.ts'
export * from './paths.ts'
export * from './protocol.ts'
export { STATE_DIR }
export type { ConsolePrefs } from './store.ts'
export { createWorkbenchSessionPort } from './workbench/session-port.ts'
export type { WorkbenchSessionPort } from './workbench/session-port.ts'

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

/** Configuration as written by a user, before the schema resolves defaults. */
type ConfigInput = {
  channels?: string[]
  layout?: ConsoleLayout
}

/**
 * Live workbench configuration, resolved by the Loader row.
 *
 * 只有**外观**留在这里。看板用哪些连接器、跑什么动作，由注册上来的连接器自己决定
 * （`ctx.console.tasks`），不再是工作台的一行配置——一枚开关管不到别人包里的实现。
 */
export interface Config {
  /** Notification channels the dispatcher runs, in selection order. */
  channels: string[]
  /** View the home list opens with. */
  layout: ConsoleLayout
}

export const Config = Schema.object({
  channels: Schema.array(Schema.union(CHANNEL_IDS.map((id) => Schema.const(id))))
    .default([...CHANNEL_IDS])
    .description('Notification channels the workbench delivers through.'),
  layout: Schema.union(['grid', 'list', 'compact'] as const)
    .default('grid')
    .description('View the home list opens with.'),
}) as Schema<ConfigInput, Config>

/**
 * Mount the workbench.
 * @param ctx - the Host plugin context.
 * @param config - the Loader row configuration, live for its whole lifetime.
 */
export function apply(ctx: Context, config: Config): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  /**
   * 规则引擎：规则文件、命中记录、待确认与撤销都归工作台持有。
   *
   * 它是库而不是插件的一半——没有连接器时它安静地什么都不做，`ctx.console.decision`
   * 仍然在，连接器（邮件…）把自己的词表与动作注册进来。**只有这一个实例**：连接器
   * 优先用它，这是「规则文件只有一份状态」的实现方式。
   */
  const decision = new TaskEngine({
    home: rulesHome(home),
    log: (line) => { ctx.logger.info(line) },
    warn: (line) => { ctx.logger.warn(line) },
  })
  void decision.start()
  ctx.effect(() => () => { decision.stop() }, 'console: stop the rule engine')
  const host = new ConsoleHost(ctx, {
    homeDir: home,
    channels: () => config.channels,
    layout: () => config.layout,
    runningSessions: async () => await readRunningSessions(ctx),
    tasks: decision,
  })

  /**
   * The consequences a *page* performs: the Web Notification and the tone exist
   * only in the browser. This half reports them as handed over — the page asks
   * for the enabled channels and performs them itself, and the presence gate has
   * already established that a page is there to do it.
   */
  registerBuiltinChannels(host.channels, { gate: host.presence, pages: HANDED_TO_PAGE })

  // 看板的真相是任务链：连接器通过 `ctx.console.tasks` 把事件喂进来，规则与编排在
  // 引擎里。装配只做两件事——把会话能力挂给工具，把任务读写给页面。
  host.attachSessions(createWorkbenchSessionPort(ctx, (line) => { ctx.logger.warn(line) }))
  // 内置连接器：和工作台同生命周期，装工作台就有，不需要单独安装一个包。
  // 它走的是同一套 ctx.console.tasks API——这条是边界的检验，不是特权。
  ctx.effect(
    () => decision.register(createDshConnector(ctx, { log: (line) => { ctx.logger.warn(line) } })),
    'console: the built-in DSH connector',
  )
  registerTasksRoutes(ctx, {
    view: () => {
      const state = decision.view()
      return { tasks: state.tasks, connectors: state.connectors, revision: state.revision }
    },
    // 引擎每走一步都会 bump：看板靠这条信号把「五秒后看到」变成「当场看到」。
    subscribe: (listener) => decision.subscribe(() => { listener() }),
    running: () => host.state().running,
    rhythm: () => host.state().archiveRhythm,
    undo: async (taskId) => await decision.undo(taskId),
    acknowledge: async (taskId, acknowledged) => await decision.acknowledge(taskId, acknowledged),
    retry: async (taskId) => await decision.retry(taskId),
    applyDeferred: async (deferredId) => await decision.applyDeferred(deferredId),
    setConnector: async (id, enabled) => await decision.setConnectorEnabled(id, enabled),
  })

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
    setArchiveRhythm: async (rhythm) => {
      await host.setArchiveRhythm(rhythm)
    },
  }

  registerRoutes(ctx, routeHost)
  registerRulesRoutes(ctx, { engine: decision })

  // 工具注册表可能比本插件晚挂载（Loader 行的顺序由用户的 profile 决定），所以跟随它
  // 出现，而不是在 apply 时判断一次就放弃（`rules/design-patterns.md`）。
  ctx.inject(['tools'], (inner) => {
    inner.effect(() => registerAgentTools(inner, host), 'console: agent tools')
  })

  ctx.logger.info(`console: workbench mounted (channels: ${host.channels.list().map((channel) => channel.id).join(', ')})`)
}

/**
 * 现在有哪些会话在干活，以及它们叫什么。
 *
 * 从 **`agents`** 注册表读「正在跑」；**创建**会话走 `sessionController`
 * （2026-10-30 实测它在 Host 侧可用，`agents.createSession` 不存在）。
 * 标题来自 `sessions` 里那条会话的标题投影，取不到时退到首条用户消息；两者都没有时
 * 返回空串，页面把它显示成「未命名会话 · 短 id」，而不是一串 UUID。
 * 结构化声明而不是 import 宿主类型：那是**可选**依赖，没挂它的部署只是首页少一块。
 * @param ctx - Host 上下文。
 * @returns 正在运行的会话；读不到时给空数组。
 */
function readRunningSessions(ctx: Context): readonly RunningSession[] {
  const sessions = ctx.get('sessions') as { get?(id: string): SessionRecordLike | undefined } | undefined
  const titles = ctx.get('sessionTitle') as SessionTitleReaderLike | undefined
  return runningSessionsOf(ctx.get('agents') as HarnessAgentsLike | undefined)
    .map((agent) => {
      const session = sessions?.get?.(agent.sessionId)
      return {
        sessionId: agent.sessionId,
        title: titleOfSession(session, titles),
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      }
    })
}
