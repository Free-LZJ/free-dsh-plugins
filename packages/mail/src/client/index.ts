/**
 * The mail panel's entry, browser half of this package.
 *
 * The panel now goes through the workbench contract
 * (`@free-lzj/dsh-console/contract`): when a workbench is loaded, mail lists
 * there and no longer takes a sidebar row of its own; when none is, it keeps the
 * classic credentials it always had. Both registration shapes are the contract's
 * job, so this file only declares what mail *is*.
 *
 * @module @free-lzj/dsh-mail/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the layout's `main` keyed-slot declaration the panel occupies.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the slot service (`ctx.slots`) and its registration contracts.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the renderer's Context merge, which is what publishes `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the sidebar's `sidebar.panellist` declaration the row occupies.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { useConsolePanel, type ConsolePanelDescriptor } from '@free-lzj/dsh-console/contract'
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
 * Register the mail panel, with the workbench when it is there and on its own
 * sidebar row when it is not.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mail: dictionaries')
  useConsolePanel(ctx, {
    id: PANEL_ID,
    title: () => t('panel'),
    description: () => t('description'),
    keywords: () => [t('panel'), 'mail', 'email', 'imap'],
    order: 20,
    // The panel's props are typed against this package's own namespace, which
    // the workbench cannot name; the layout hands every `main` occupant the same
    // two seats it always did.
    render: MailPanel as unknown as ConsolePanelDescriptor['render'],
    icon: createElement(MailIcon, { size: 16 }),
  }, {
    locale: NS,
    order: 40,
    label: () => t('panel'),
    Icon: MailIcon,
  })
}
