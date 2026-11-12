/**
 * Browser use for DSH — Host half.
 *
 * Two halves of one idea, and they are deliberately different in kind:
 *
 * - **Mentioning** is ours. Nothing in the harness lists what a person has open,
 *   so this plugin contributes that: a provider registry, one read-only route,
 *   and a browser provider on top of `bsk tab list`.
 * - **Operating** is BrowserSkill's. Its CLI already ships an MCP server with the
 *   full action set, and the harness already knows how to give one MCP server to
 *   one Session — `mountSessionMcp` is what the official Chrome DevTools and
 *   Playwright providers use. Rebuilding those tools here would mean shipping a
 *   copy that drifts from upstream on every release.
 *
 * The skill body travels with the plugin for the same reason: installing this is
 * meant to be enough, so the separate `browser-skill` agent skill is not needed.
 *
 * @module @free-lzj/dsh-browser-use
 */

import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
// Type-only: the `ctx.skills` registry merge the bundled skill registers onto.
import type {} from '@deepseek-ai/dsh-skill'
import { BskCli } from './bsk.ts'
import { browserMentionProvider } from './browser-mention.ts'
import { MentionRegistry } from './mention.ts'
import { registerRoutes } from './routes.ts'
import { BROWSER_SKILL } from './skill.ts'

export { BskCli, type BskConfig, type TabRequest, type TabActionResult } from './bsk.ts'
export { browserMentionProvider } from './browser-mention.ts'
export { MentionRegistry, type CollectedMentions, type MentionProvider } from './mention.ts'
export * from './protocol.ts'
export { isSameOrigin, registerRoutes, respond } from './routes.ts'
export { BROWSER_SKILL, SKILL_NAME } from './skill.ts'

/**
 * MCP server name; every tool this plugin contributes is `mcp__<name>__*`.
 *
 * Not `bsk` and not `browser`: the name is a namespace the model reads on every
 * call, so it should say whose tools these are and never collide with a server
 * the person wired up themselves.
 */
export const MCP_SERVER_NAME = 'browser-skill'

/**
 * The `bsk` executable.
 *
 * An override exists because a machine can have a stale global install next to
 * the one the extension pairs with, and the wrong one fails as an opaque
 * transport error rather than as "wrong binary".
 */
function bskCommand(): string {
  return process.env['DSH_BSK_PATH'] ?? 'bsk'
}

/**
 * Mount BrowserSkill's MCP server once, for the whole Host.
 *
 * The harness's experimental browser-use runtime would mount one server per
 * Session, but it ships outside the dsh installation and needs a provider
 * registry (`ctx.browserUse`) that not every profile carries. This plugin mounts
 * one server instead: every Agent sees `mcp__browser-skill__*`, and the cost is
 * that two Sessions driving the browser at once share a single BrowserSkill
 * session — and therefore one Agent Window. For one person in one conversation
 * that is the honest trade; a per-Session server would need the runtime package.
 * @param ctx - the Host plugin context.
 */
export function mountBrowserTools(ctx: Context): void {
  ctx.inject(['tools', 'systemPrompt'], (inner) => {
    try {
      inner.plugin(McpClient, McpClient.Config({
        transport: 'stdio',
        serverName: MCP_SERVER_NAME,
        command: bskCommand(),
        args: ['mcp'],
        // A missing or broken `bsk` costs the browser tools, not the plugin:
        // mentioning, the bundled skill, and everything else keep working. The
        // MCP client logs the reason itself when startup fails.
        failOnStartupError: false,
        reconnect: { enabled: false },
      }))
      inner.logger.info(`browser-use: browser tools mounted as mcp__${MCP_SERVER_NAME}__*`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      inner.logger.warn(`browser-use: could not mount the browser MCP server: ${message}`)
    }
  })
}

/**
 * Register the skill body that makes a separate `browser-skill` install unnecessary.
 * @param ctx - the Host plugin context.
 */
export function registerSkill(ctx: Context): void {
  ctx.inject(['skills'], (inner) => {
    inner.effect(() => inner.skills.register(BROWSER_SKILL), 'browser-use: bundled skill')
    inner.logger.info(`browser-use: skill "${BROWSER_SKILL.name}" registered`)
  })
}

/**
 * Mount the mention route, the provider, the bundled skill, and the browser tools.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: Context): void {
  // One CLI handle for the mention path: listing tabs opens a browser session,
  // and a second handle would open a second one for no reason.
  const cli = new BskCli()
  const registry = new MentionRegistry()

  ctx.effect(() => registry.register(browserMentionProvider(cli)), 'browser-use: browser provider')
  registerRoutes(ctx, registry)
  ctx.effect(() => () => { void cli.dispose() }, 'browser-use: bsk session')

  // The operating half: BrowserSkill's own MCP tools, one server per Session.
  mountBrowserTools(ctx)
  registerSkill(ctx)

  ctx.logger.info('browser-use: mounted')
}
