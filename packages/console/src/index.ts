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
import { ConsoleHost } from './console-host.ts'
import { BUILTIN_CHANNELS, type ConsoleLayout } from './protocol.ts'
import { registerRoutes, type RouteHost } from './routes.ts'

export { ConsoleHost } from './console-host.ts'
export type { ConsoleEvent, ConsoleHostOptions } from './console-host.ts'
export { ChannelRegistry } from './channels.ts'
export type { DispatchResult, NoticeDelivery, NotificationChannel } from './channels.ts'
export { PresenceGate, registerBuiltinChannels } from './builtin-channels.ts'
export type { BuiltinChannelWiring, PageSurfaces } from './builtin-channels.ts'
export * from './paths.ts'
export * from './protocol.ts'
export { STATE_DIR } from './store.ts'
export type { ConsolePrefs } from './store.ts'

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

/** Configuration as written by a user, before the schema resolves defaults. */
type ConfigInput = {
  channels?: string[]
  layout?: ConsoleLayout
}

/** Live workbench configuration, resolved by the Loader row. */
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
  const host = new ConsoleHost(ctx, {
    homeDir: home,
    channels: () => config.channels,
    layout: () => config.layout,
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
  }

  registerRoutes(ctx, routeHost)

  ctx.logger.info(`console: workbench mounted (channels: ${host.channels.list().map((channel) => channel.id).join(', ')})`)
}
