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
import { DecisionEngine } from '@free-lzj/dsh-decision'
import { registerBuiltinChannels, type PageSurfaces } from './builtin-channels.ts'
import { STATE_DIR } from './store.ts'
import { ConsoleHost } from './console-host.ts'
import { BUILTIN_CHANNELS, type ConsoleLayout, type RunningSession } from './protocol.ts'
import { registerRoutes, type RouteHost } from './routes.ts'
import { registerRulesRoutes, rulesHome } from './rules/index.ts'
import { registerAgentTools } from './tools.ts'
import { WorkbenchBoard, type ExecutorNote } from './workbench/board.ts'
import { ClassifierRegistry, RULE_CLASSIFIER_ID, RuleClassifier } from './workbench/classifier.ts'
import { LlmClassifier, modelRoute, type LlmPortLike } from './workbench/llm-classifier.ts'
import { builtinConnectors, ConnectorRegistry } from './workbench/connectors.ts'
import { ExecutorRegistry, SimulatedExecutor } from './workbench/executors.ts'
import {
  createHarnessRunner, runningSessionsOf, titleOfSession, type HarnessAgentLike, type HarnessAgentsLike,
  type HarnessSessionEventLike, type SessionRecordLike, type SessionTitleReaderLike,
} from './workbench/harness-session.ts'
import { RealSessionExecutor } from './workbench/real-session.ts'
import { createWorkbenchSessionPort, type SessionControllerLike } from './workbench/session-port.ts'
import { defaultRoutingTable, RoutingTableStore } from './workbench/routing.ts'
import { registerWorkbenchRoutes } from './workbench/routes.ts'

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
  workbenchModel?: string
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
  /** Directory real runs happen in; empty means the `dsh` executor is not registered. */
  workbenchWorkspace: string
  /** `provider/model` the LLM classifier asks; empty leaves it without a route. */
  workbenchModel: string
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
    .description('Directory real DSH sessions run in; empty leaves the dsh executor unregistered.'),
  workbenchModel: Schema.string()
    .default('')
    .description('provider/model the LLM classifier asks (e.g. deepseek/deepseek-chat); empty names none.'),
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
  const decision = new DecisionEngine({
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
    decision,
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
  // 模型分类器：宿主组合了 `llm` 且配置里点了模型时才注册。调用形状取自宿主自己的
  // `dsh-session-title-llm`（prepareCall → stream 的 text-delta），不是猜的。
  ctx.inject(['llm'], (inner) => {
    const llm = inner.get('llm') as LlmPortLike | undefined
    if (llm === undefined) return
    classifiers.register(new LlmClassifier({
      llm,
      route: () => modelRoute(config.workbenchModel),
      fallback: new RuleClassifier(),
    }))
    inner.logger.info(`console: llm classifier ${config.workbenchModel === '' ? 'registered (no model configured)' : `on (${config.workbenchModel})`}`)
  })
  const executors = new ExecutorRegistry()
  // `dsh` 只有真实会话这一种实现：派给 DSH 就是把卡变成一条真实会话，没有模拟版。
  // （`codex` 仍是模拟，等它的真实接入单独做。）
  executors.register(new SimulatedExecutor('codex', 'Codex（模拟）'))
  // 真实会话执行器：等 `sessionController` 服务就位之后才注册。
  //
  // 2026-10-30 真机复核（见 `docs/workbench-session-api.md`）：宿主里有
  // `sessionController`，`create` / `resolveAgent` / `rename` / `followup` 可从 Host
  // 调用；`agents.createSession` **不存在**。会话事件仍走 `ctx.on('session/event')`。
  let realRegistered = false
  /** 为什么没有真实执行器：给连接器页用，空串表示有。 */
  let note: ExecutorNote = 'no-session-api'
  // `sessionController` 是本机真正能建会话的服务（mail 的分类会话就是它建的）；
  // `agents.createSession` 在这个宿主里不存在，按它写只会注册一个永远不触发的执行器。
  ctx.inject(['sessionController'], (inner) => {
    if (realRegistered) return
    const controller = inner.get('sessionController') as SessionControllerLike | undefined
    if (config.workbenchWorkspace === '') {
      note = 'no-workspace'
      return
    }
    if (controller === undefined) return
    // 真实执行器只依赖「建会话 + 拿 agent」两个动词，二者都由 sessionController 提供。
    const agents: HarnessAgentsLike = {
      createSession: async (request) => {
        const created = await controller.create(request)
        const resolved = await controller.resolveAgent(created.sessionId)
        if ('error' in resolved) {
          throw new Error(`会话已建但取不到 agent：${describeError(resolved.error)}`)
        }
        return { agent: resolved.agent as unknown as HarnessAgentLike }
      },
    }
    const runner = createHarnessRunner({
      agents,
      cwd: config.workbenchWorkspace,
      // 事件类型是宿主自己的联合类型；消费方只关心 type 与 reason.kind，所以在边界上收窄一次。
      subscribe: (listener) => inner.on('session/event', (session, event) => {
        listener(session as { id?: string }, event as unknown as HarnessSessionEventLike)
      }),
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
    note = ''
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
    executorNote: () => (realRegistered ? '' : note),
    connectors,
    routing,
    enabledConnectors: () => config.workbenchConnectors,
    classifierId: () => config.workbenchClassifier,
    warn: (line) => {
      ctx.logger.warn(line)
    },
  })
  host.attachWorkbench(board)
  // 会话能力由工作台提供：连接器只负责「说什么、在哪个目录说」。
  host.attachSessions(createWorkbenchSessionPort(ctx, board))
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
  registerRulesRoutes(ctx, { engine: decision })

  // 工具注册表可能比本插件晚挂载（Loader 行的顺序由用户的 profile 决定），所以跟随它
  // 出现，而不是在 apply 时判断一次就放弃（`rules/design-patterns.md`）。
  ctx.inject(['tools'], (inner) => {
    inner.effect(() => registerAgentTools(inner, host), 'console: agent tools')
  })

  ctx.logger.info(`console: workbench mounted (channels: ${host.channels.list().map((channel) => channel.id).join(', ')})`)
  ctx.logger.info(`console: board mounted (connectors: ${connectors.list().map((connector) => connector.id).join(', ')})`)
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

/** One error as a sentence (the controller reports errors as values, not throws). */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
