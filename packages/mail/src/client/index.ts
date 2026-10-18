/**
 * The mail panel's sidebar entry, browser half of this package.
 *
 * A first-class main panel: one icon in the sidebar's global panel list, and the
 * same id addressing this front end's component in the layout's `main` keyed
 * slot. The Host half — the Loader row that mounts this package — owns the IMAP
 * connections and serves both the panel document and the inbox state it reads.
 *
 * `order: 40` places the entry after the shipped panels (Plugins at 0,
 * Automation tasks at 10) and after the Context Insights entry a third-party
 * context plugin registers at 20.
 *
 * @module @free-lzj/dsh-mail/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the layout's `main` keyed-slot declaration this page occupies.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the slot service (`ctx.slots`) and its registration contracts.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the renderer's Context merge, which is what publishes `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the sidebar's `sidebar.panellist` declaration this icon occupies.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { MailIcon } from './MailIcon.tsx'
import { MailPanel } from './MailPanel.tsx'
import { en, zh, type MailLocaleKey } from './locales.ts'

export type { MailPanelProps } from './MailPanel.tsx'
export type { MailLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mail panel copy. */
    'panel.mail': MailLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'panel.mail'

/** Id shared by the sidebar entry and the main-panel key it addresses. */
export const PANEL_ID = 'mail'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the sidebar entry and the panel it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mail: dictionaries')
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
  }, MailPanel)), 'mail: panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel'),
  }, MailIcon)), 'mail: sidebar entry')
}
