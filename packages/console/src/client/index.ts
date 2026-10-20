/**
 * The workbench, browser half: the seats it takes and the service it offers.
 *
 * Three seats and one service.
 *
 * - `main:console` — the home list, drawn by `ConsoleShell`.
 * - `sidebar.panellist` (id `console`, order 0) — the workbench row; the shell
 *   draws it and routes its click through `ctx.layout.selectPanel`.
 * - `settings.general.item` — the notification multi-select.
 * - `console` (a client service) — what an adopting plugin's browser half
 *   injects. See `./contract.ts`; this file only provides it.
 *
 * The home list is assembled here from two facts that live in different places:
 * the adopted panels (this side — a panel's title and glyph are declared by its
 * own plugin's browser half) and the stored pin list (the Host). That
 * is why the list contains the workbench's own panels and nothing else.
 *
 * @module @free-lzj/dsh-console/client
 */

// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.layout and the layout's `main` keyed-slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the renderer's Context merge, which publishes `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot types (`settings.general.item`).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the sidebar's `sidebar.panellist` declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CONSOLE_PANEL_ID, type ConsoleLayout, type ConsoleNoticeRecord } from '../protocol.ts'
import type { ConsoleClientService } from './contract.ts'
import { bindSelector, link } from './link.ts'
import { PanelRegistry, panelRows, type PanelRow } from './registry.ts'
import { ConsoleIcon, ConsoleShell } from './shell.tsx'
import { ConsoleSettingsRow } from './settings-row.tsx'
import { createPageFace, desktopBlockedReason } from './surfaces.ts'
import { installConsoleStyles } from './styles.ts'
import { en, zh, type ConsoleLocaleKey } from './locales.ts'

export type { ConsoleClientService, ConsolePanelDescriptor, StandalonePanelOptions } from './contract.ts'
export { CONSOLE_SERVICE, consoleService } from './contract.ts'
export { useConsolePanel } from './register.ts'
export type { ChannelInfo, ConsoleLayout, ConsoleNotice, ConsoleNoticeRecord, ConsoleState } from '../protocol.ts'
export type { PanelRow } from './registry.ts'
export { CONSOLE_PANEL_ID } from '../protocol.ts'
export { ConsoleIcon } from './shell.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench copy. */
    console: ConsoleLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'console'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'layout']

/** Id of the notification settings row this plugin contributes. */
export const SETTINGS_ROW_ID = 'console.notifications'

/** How many notices this page keeps before the Host's stored list takes over. */
const LIVE_NOTICE_LIMIT = 50

/**
 * Mount the workbench.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'console: dictionaries')
  ctx.effect(() => installConsoleStyles(), 'console: styles')

  const registry = new PanelRegistry()
  const face = createPageFace()
  let liveNotices: readonly ConsoleNoticeRecord[] = []

  /**
   * The rows the home list draws.
   *
   * Both inputs move independently — a plugin can adopt at any moment, and the
   * user can pin from another tab — so the join happens per read and the
   * snapshot reference changes only when a row actually differs.
   */
  const rows: { getSnapshot(): readonly PanelRow[]; subscribe(fn: () => void): () => void } = (() => {
    const listeners = new Set<() => void>()
    let snapshot: readonly PanelRow[] = []
    const recompute = (): void => {
      const state = link.getSnapshot()
      const next = panelRows(registry.getSnapshot(), state?.pinned ?? [])
      if (sameRows(snapshot, next)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    }
    registry.subscribe(recompute)
    link.subscribe(recompute)
    return {
      getSnapshot: () => snapshot,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    }
  })()
  const useRows = bindSelector<readonly PanelRow[]>(rows)
  const notices = {
    getSnapshot: (): readonly ConsoleNoticeRecord[] => link.getSnapshot()?.notices ?? [],
    subscribe: (fn: () => void) => link.subscribe(fn),
  }
  const useNotices = bindSelector<readonly ConsoleNoticeRecord[]>(notices)

  ctx.provide('console', {
    register: (descriptor) => registry.register(descriptor),
  } satisfies ConsoleClientService)

  // The stream is the fast path; the Host's stored list is what survives a
  // reload. The page also performs what only a page can — the desktop
  // notification and the tone — for the notices the Host says it delivered.
  ctx.effect(() => link.onNotice(({ notice }) => {
    liveNotices = [notice, ...liveNotices].slice(0, LIVE_NOTICE_LIMIT)
    if (notice.delivered.includes('desktop')) {
      void face.raise({
        title: notice.title,
        ...(notice.body === undefined ? {} : { body: notice.body }),
        ...(notice.tone === undefined ? {} : { tone: notice.tone }),
      })
    }
    if (notice.delivered.includes('sound')) face.chime(notice.tone)
  }), 'console: page channels')

  ctx.effect(() => {
    link.open(ctx.locale.getLocale().active)
    return () => {
      link.dispose()
    }
  }, 'console: host link')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: CONSOLE_PANEL_ID,
    locale: NS,
    inject: () => ({
      useRows,
      useNotices,
      layout: () => link.layoutPreference(),
      open: (panel: PanelRow) => {
        try {
          ctx.layout.selectPanel(panel.id as Parameters<typeof ctx.layout.selectPanel>[0])
        } catch {
          // An id nothing registered (a plugin that withdrew between paint and
          // click) must not take the workbench down with it.
        }
      },
      togglePin: (panel: PanelRow) => link.setPinned(panel.id, !panel.pinned),
      setLayout: (layout: ConsoleLayout) => link.setLayout(layout),
      clearNotices: () => {
        liveNotices = []
        void link.clearNotices()
      },
      liveNotices: () => liveNotices,
    }),
  }, ConsoleShell)), 'console: home list')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: CONSOLE_PANEL_ID,
    order: 0,
    locale: NS,
    label: () => t('panel'),
  }, ConsoleIcon)), 'console: sidebar row')

  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: SETTINGS_ROW_ID,
    order: 60,
    inject: () => ({
      t,
      useChannels: () => link.getSnapshot()?.availableChannels ?? [],
      saveChannels: (channels: readonly string[]) => link.saveChannels(channels),
      useDesktopBlocked: () => desktopBlockedReason(),
    }),
  }, ConsoleSettingsRow)), 'console: notification settings row')
}

/**
 * Whether two row lists are the same list.
 * @param left - the previous rows.
 * @param right - the candidate rows.
 * @returns true when every row matches field for field, in order.
 */
function sameRows(left: readonly PanelRow[], right: readonly PanelRow[]): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => {
    const other = right[index]
    return other !== undefined
      && row.id === other.id
      && row.title === other.title
      && row.description === other.description
      && row.order === other.order
      && row.pinned === other.pinned
      && row.icon === other.icon
  })
}
