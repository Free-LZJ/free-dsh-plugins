/**
 * The Plugins-page card, browser half of this package: what the Host half reads
 * from Codex and Claude Code, and how the import is bounded. The card registers
 * into the Plugins page's `plugins.item` slot while the Host serves the
 * `agent-import` settings namespace — the namespace of the Loader row that
 * mounts this package — so it appears as a card of its own and a deployment
 * that never loaded the row shows no trace of it.
 *
 * The card carries two hooks: the configuration the Host serves, and the import
 * report the Host answers on its own route. The report is read through a
 * same-origin request, so it needs no cooperation from the Host page.
 *
 * Only this directory reaches the browser bundle. The Host half's modules may be
 * reached for *types* (`import type`, erased at build time), never for values:
 * the bundle would then inline `yaml` and the MCP client into the browser.
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
import { installAgentImportStyles } from './agent-import-card-style.ts'
import { AGENT_IMPORT_NS, AgentImportCardController } from './agent-import-card-controller.ts'
import { loadAgentImportReport } from './agent-import-report.ts'
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
 * Mount the Plugins-page card while the Host serves the row's own settings namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-import: dictionaries')
  ctx.effect(() => installAgentImportStyles(), 'agent-import: card styles')
  const card = new AgentImportCardController(ctx.configForms.get(AGENT_IMPORT_NS), loadAgentImportReport)
  ctx.effect(() => () => { card.dispose() }, 'agent-import: form subscription')
  card.refreshReport()
  ctx.effect(() => ctx.configForms.whileServed([AGENT_IMPORT_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'agent-import', order: 50, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, AgentImportCard))), 'agent-import: page')
}
