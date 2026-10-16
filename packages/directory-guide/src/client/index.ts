/**
 * The directory guide's sidebar entry, browser half of this package.
 *
 * A first-class main panel: one icon in the sidebar's global panel list, and
 * the same id addressing this front end's component in the layout's `main`
 * keyed slot. The Host half — the Loader row that mounts this package — serves
 * the document the panel frames and the snapshot it reads.
 *
 * `order: 30` places the entry after the shipped panels (Plugins at 0,
 * Automation tasks at 10) and after the Context Insights entry a third-party
 * context plugin registers at 20.
 *
 * @module @free-lzj/dsh-directory-guide/client
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
import { GuideIcon } from './GuideIcon.tsx'
import { GuidePanel } from './GuidePanel.tsx'
import { en, zh, type GuideLocaleKey } from './locales.ts'

export type { GuidePanelProps } from './GuidePanel.tsx'
export type { GuideLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Directory-guide panel copy. */
    'panel.directoryGuide': GuideLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'panel.directoryGuide'

/** Id shared by the sidebar entry and the main-panel key it addresses. */
export const PANEL_ID = 'directory-guide'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the sidebar entry and the panel it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'directory-guide: dictionaries')
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
  }, GuidePanel)), 'directory-guide: panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => t('panel'),
  }, GuideIcon)), 'directory-guide: sidebar entry')
}
