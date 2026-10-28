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
import {
  CONSOLE_FOCUS_PANEL_ID, CONSOLE_PANEL_ID, type ConsoleLayout, type ConsoleNoticeRecord, type ConsoleView,
  type WorkbenchState,
} from '../protocol.ts'
import type { ConsoleClientService } from './contract.ts'
import { bindSelector, link } from './link.ts'
import { WorkbenchLink } from './workbench/link.ts'
import type { WorkbenchFace } from './workbench/board.tsx'
import { PanelRegistry, panelRows, type PanelRow } from './registry.ts'
import { createTriageSource } from './rules.tsx'
import { ConsoleIcon, ConsoleShell, FocusShell, type ConsoleShellProps } from './shell.tsx'
import { ConsoleSettingsRow } from './settings-row.tsx'
import { createPageFace, desktopBlockedReason } from './surfaces.ts'
import { installConsoleStyles } from './styles.ts'
import { en, zh, type ConsoleLocaleKey } from './locales.ts'

/** The workbench's two main panels, as the seat that speaks. */
type ConsoleSeat = 'console' | 'console-focus'

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
  // 规则视图的数据源：引擎现在住在 mail 里，P1a 之后换的是这一个对象。
  const triage = createTriageSource()
  const face = createPageFace()
  const workbenchLink = new WorkbenchLink()
  const useBoard = bindSelector<WorkbenchState | undefined>(workbenchLink)
  const workbenchFace: WorkbenchFace = {
    useBoard,
    dispatch: (cardId, executor) => workbenchLink.act({
      action: 'dispatch',
      cardId,
      ...(executor === undefined ? {} : { executor }),
    }),
    move: (cardId, column) => workbenchLink.act({ action: 'move', cardId, column }),
    interrupt: (sessionId, text) => workbenchLink.act({ action: 'interrupt', sessionId, text }),
    pause: (sessionId) => workbenchLink.act({ action: 'pause', sessionId }),
    resume: (sessionId) => workbenchLink.act({ action: 'resume', sessionId }),
    end: (sessionId) => workbenchLink.act({ action: 'end', sessionId }),
    confirm: (cardId) => workbenchLink.act({ action: 'confirm', cardId }),
  }
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
  const views = {
    getSnapshot: (): ConsoleView => link.viewPreference(),
    subscribe: (fn: () => void) => link.subscribe(fn),
  }
  const useView = bindSelector<ConsoleView>(views)

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

  ctx.effect(() => {
    workbenchLink.open()
    return () => {
      workbenchLink.dispose()
    }
  }, 'console: workbench link')

  /**
   * 打开一个面板。
   *
   * 为什么不是一行 `selectPanel`：那个调用**会抛**（`layout.selectPanel: main panel "x"
   * is not registered`），而这里原来把抛吞掉了——于是「点进去什么也没有」，用户看到的
   * 是空白，看不到原因。
   *
   * 补注册要小心：`main` 是**键控**槽，同键同优先级再注册会直接抛
   * （`keyed slot "main" already has an entry for key "x" at priority 0`）。所以先看
   * 这条键在不在注册表里——在，就说明问题不是「没注册」，补一次只会制造错误；不在，
   * 才按**更低的优先级**（`priority` 越低越先渲染）补一次，这样即便还有一条僵尸条目
   * 也能盖住它。
   * @param panel - 被打开的那一行。
   * @returns 成功，或者一句能显示给人看的原因。
   */
  const openPanel = (panel: PanelRow): { readonly ok: boolean; readonly message?: string } => {
    const select = (): boolean => {
      try {
        ctx.layout.selectPanel(panel.id as Parameters<typeof ctx.layout.selectPanel>[0])
        return true
      } catch {
        return false
      }
    }
    if (select()) return { ok: true }
    const descriptor = registry.get(panel.id)?.descriptor
    if (descriptor === undefined) {
      return { ok: false, message: `「${panel.title}」没有注册到 main 槽，工作台手里也没有它的渲染器` }
    }
    const slots = ctx.slots as unknown as {
      entries?: (name: string) => readonly { options?: { key?: string } }[]
    }
    const present = (slots.entries?.('main') ?? [])
      .some(entry => entry.options?.key === panel.id)
    if (present) {
      return { ok: false, message: `「${panel.title}」在 main 槽里，但布局不肯显示它（selectPanel 被拒）` }
    }
    try {
      ctx.slots.register(
        { name: 'main', key: panel.id, locale: NS, priority: -1 } as never,
        descriptor.render as never,
      )
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    return select() ? { ok: true } : { ok: false, message: `补注册「${panel.title}」之后仍然打不开` }
  }

  /**
   * 切到一个视图。
   *
   * 四个视图住在 `main:console` 里，切换只是改自己记着的那个值；**聚焦**是第二个
   * main panel，所以那一次切换是 `selectPanel`——它会抛，抛了就把原因交回去显示，
   * 而不是把异常吞掉（§4.1 里那两条实现注意）。
   * @param seat - 发起这次切换的页面。
   * @param view - 目标视图。
   * @returns 成功，或者一句能显示给人看的原因。
   */
  const navigate = (seat: ConsoleSeat, view: ConsoleView): { readonly ok: boolean; readonly message?: string } => {
    const target = view === 'focus' ? CONSOLE_FOCUS_PANEL_ID : CONSOLE_PANEL_ID
    if (target !== seat) {
      try {
        ctx.layout.selectPanel(target as Parameters<typeof ctx.layout.selectPanel>[0])
      } catch (error: unknown) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
    // 切换之后再记：丢进 prefs 的必须是真正到得了的那个视图。
    link.setView(view)
    return { ok: true }
  }

  /**
   * 一个页面的注入面。两个 main panel 共用同一份：状态条、通知、面板目录都不该
   * 因为换了一页而换一套数据。
   * @param seat - 这个页面自己是谁。
   * @returns 槽位要传给组件的 props。
   */
  const seatProps = (seat: ConsoleSeat): ConsoleShellProps => ({
    t,
    useRows,
    useNotices,
    awaiting: () => link.getSnapshot()?.awaiting ?? 0,
    running: () => link.getSnapshot()?.running ?? [],
    log: () => link.getSnapshot()?.log ?? [],
    layout: () => link.layoutPreference(),
    useView,
    navigate: (view: ConsoleView) => navigate(seat, view),
    open: openPanel,
    togglePin: (panel: PanelRow) => link.setPinned(panel.id, !panel.pinned),
    setLayout: (layout: ConsoleLayout) => link.setLayout(layout),
    clearNotices: () => {
      liveNotices = []
      void link.clearNotices()
    },
    actOnItem: (id: string, actionId: string) => link.actOnItem({ op: 'act', id, actionId }),
    dismissItem: (id: string) => link.actOnItem({ op: 'dismiss', id }),
    liveNotices: () => liveNotices,
    workbench: workbenchFace,
    triage,
  })

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: CONSOLE_PANEL_ID,
    locale: NS,
    inject: () => seatProps('console'),
  }, ConsoleShell)), 'console: workbench page')

  // 聚焦页是**第二个** main panel（决策 Q1）：导航点「聚焦」时是真正的页面切换，
  // 两个页面各自持自己的内容。
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: CONSOLE_FOCUS_PANEL_ID,
    locale: NS,
    inject: () => seatProps('console-focus'),
  }, FocusShell)), 'console: focus page')

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
