/**
 * The agent-import settings page, browser half: what
 * `@deepseek-ai/dsh-agent-import` reads from Codex and Claude Code, and how the
 * import is bounded. The page registers into the Plugins page's
 * `plugins.item` slot while the Host serves the `agent-import` settings
 * namespace, so it appears as a card of its own and a deployment without the
 * plugin shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AgentImportCard } from './AgentImportCard.tsx'
import { AGENT_IMPORT_NS, AgentImportCardController } from './agent-import-card-controller.ts'
import { en, zh, type AgentImportLocaleKey } from './locales.ts'

export type { AgentImportCardProps } from './AgentImportCard.tsx'
export type { AgentImportCardFace, AgentImportPageState, AgentImportSourceState } from './agent-import-card-controller.ts'
export type { AgentImportLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent-import configuration page copy. */
    'settings.agentImport': AgentImportLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.agentImport'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the agent-import settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-agent-import: dictionaries')
  const card = new AgentImportCardController(ctx.configForms.get(AGENT_IMPORT_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-agent-import: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([AGENT_IMPORT_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'agent-import', order: 50, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, AgentImportCard))), 'ui-settings-agent-import: page')
}
