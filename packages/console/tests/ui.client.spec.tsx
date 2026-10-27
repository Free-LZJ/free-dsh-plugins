// @vitest-environment jsdom
/**
 * The workbench shell: what the pages are built from, and how the user meets them.
 *
 * The pages are the join of two facts owned by different halves — the panels a
 * browser half adopted, and the pin list the Host stored — plus the view the user
 * is on. The rules that have no other guard live here: **only adopted panels ever
 * appear** (the workbench shows the plugins that joined it, not everything the
 * profile loaded), the user must not be able to switch every notification
 * channel off, and a view that cannot be reached says why instead of doing
 * nothing.
 *
 * @module @free-lzj/dsh-console/tests/ui
 */

import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChannelInfo, ConsoleLogEntry, ConsoleNoticeRecord, ConsoleView, RunningSession,
} from '../src/protocol.ts'
import { ConsoleShell, mergeNotices } from '../src/client/shell.tsx'
import { ConsoleSettingsRow } from '../src/client/settings-row.tsx'
import { PanelRegistry, filterPanels, panelRows, type PanelRow } from '../src/client/registry.ts'
import type { ConsolePanelDescriptor } from '../src/client/contract.ts'
import { zh, type Translate } from '../src/client/locales.ts'

// Vitest runs without globals here, so Testing Library's own auto-cleanup has
// nothing to hook: without this, every test renders into the previous DOM.
afterEach(cleanup)

/**
 * Give jsdom the layout facts the placement hook clamps against.
 *
 * jsdom has no layout engine: every `offsetWidth` is 0 and every
 * `getBoundingClientRect` is empty, which is exactly the zero-size reading the
 * overflow bug depended on. Stubbing the two reads keeps the component real
 * while letting the clamp actually run.
 * @param geometry - panel size, viewport size, and the anchor's viewport rect.
 * @returns the disposer restoring every patched descriptor.
 */
function stubLayout(geometry: {
  readonly panelWidth: number
  readonly panelHeight: number
  readonly viewport: readonly [number, number]
  readonly anchor: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
}): () => void {
  const patched: Array<() => void> = []
  const patch = (target: object, key: string, define: () => PropertyDescriptor | undefined): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, define() ?? { configurable: true, value: 0 })
    patched.push(() => {
      if (previous === undefined) delete (target as Record<string, unknown>)[key]
      else Object.defineProperty(target, key, previous)
    })
  }
  patch(window, 'innerWidth', () => ({ configurable: true, value: geometry.viewport[0] }))
  patch(window, 'innerHeight', () => ({ configurable: true, value: geometry.viewport[1] }))
  patch(HTMLElement.prototype, 'offsetWidth', () => ({
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('dshc-notice-panel') ? geometry.panelWidth : 0 },
  }))
  patch(HTMLElement.prototype, 'offsetHeight', () => ({
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('dshc-notice-panel') ? geometry.panelHeight : 0 },
  }))
  patch(HTMLElement.prototype, 'getBoundingClientRect', () => ({
    configurable: true,
    value(this: HTMLElement): DOMRect {
      // The placement hook measures the registration's anchor — the span that
      // wraps the trigger button, not the button itself. Everything else reports
      // an empty box, which is what jsdom would have said anyway.
      const isAnchor = this.tagName === 'SPAN' && this.querySelector('button[aria-haspopup="dialog"]') !== null
      const { left, right, top, bottom } = isAnchor ? geometry.anchor : { left: 0, right: 0, top: 0, bottom: 0 }
      return {
        left, right, top, bottom,
        x: left, y: top, width: right - left, height: bottom - top,
        toJSON: () => ({}),
      } as DOMRect
    },
  }))
  return () => {
    for (const undo of patched.reverse()) undo()
  }
}

/** Translate through the real dictionary, so a missing key fails here too. */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** A panel an adopting plugin would declare. */
function descriptor(id: string, title: string, extra: Partial<ConsolePanelDescriptor> = {}): ConsolePanelDescriptor {
  return { id, title: () => title, render: () => null, ...extra }
}

/** One row of the home list. */
function row(id: string, title: string, extra: Partial<PanelRow> = {}): PanelRow {
  return { id, title, order: 10, pinned: false, ...extra }
}

/**
 * A tiny store standing in for the Host-backed view preference.
 *
 * The real `useView` subscribes to the page's link; a fake getter would freeze
 * the page after a click, and "click 应用, see the directory" is exactly what
 * these tests are here to check.
 * @param initial - the view the page opens on.
 * @returns the snapshot reader, the writer, and the subscription.
 */
function viewStore(initial: ConsoleView) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    set: (next: ConsoleView): void => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The shell's injected face, recording what it was asked to do. */
function shellFace(
  rows: readonly PanelRow[],
  notices: readonly ConsoleNoticeRecord[] = [],
  running: readonly RunningSession[] = [],
  logEntries: readonly ConsoleLogEntry[] = [],
  options: {
    /** 让「打开」失败，用来验证失败会被说出来。 */
    readonly openOutcome?: { readonly ok: boolean; readonly message?: string }
    /** 让「切视图」失败，同上。 */
    readonly navigateOutcome?: { readonly ok: boolean; readonly message?: string }
    /** 页面打开时所在的视图。 */
    readonly view?: ConsoleView
  } = {},
) {
  const calls = {
    open: [] as string[],
    nav: [] as string[],
    pin: [] as string[],
    layout: [] as string[],
    cleared: 0,
    /** 点击过的 (条目 id, 动作 id)。 */
    acted: [] as string[],
    dismissed: [] as string[],
  }
  const views = viewStore(options.view ?? 'board')
  const openOutcome = options.openOutcome ?? { ok: true }
  return {
    calls,
    face: {
      t,
      useRows: <S,>(select: (all: readonly PanelRow[]) => S) => select(rows),
      useNotices: <S,>(select: (all: readonly ConsoleNoticeRecord[]) => S) => select(notices),
      useView: <S,>(select: (view: ConsoleView) => S) => select(useSyncExternalStore(views.subscribe, views.getSnapshot)),
      // 「待处理」由 Host 算；这些用例里就是状态为 new 的条数。
      awaiting: () => notices.filter(notice => notice.state === 'new').length,
      running: () => running,
      log: () => logEntries,
      layout: () => 'grid' as const,
      navigate: (view: ConsoleView) => {
        calls.nav.push(view)
        const outcome = options.navigateOutcome ?? { ok: true }
        if (outcome.ok) views.set(view)
        return outcome
      },
      open: (panel: PanelRow) => {
        calls.open.push(panel.id)
        // 这几条用例走的是「打得开」的路；打不开的那条在下面单独测。
        return openOutcome
      },
      togglePin: (panel: PanelRow) => calls.pin.push(panel.id),
      setLayout: (layout: string) => calls.layout.push(layout),
      clearNotices: () => { calls.cleared += 1 },
      actOnItem: async (id: string, actionId: string) => {
        calls.acted.push(`${id}:${actionId}`)
        return { ok: true }
      },
      dismissItem: async (id: string) => {
        calls.dismissed.push(id)
        return { ok: true }
      },
      liveNotices: () => [],
    },
  }
}

/** Switch the page to 应用, where the panel directory lives. */
function openApps(): void {
  fireEvent.click(screen.getByRole('button', { name: t('viewApps') }))
}

describe('what the list is built from', () => {
  it('contains the adopted panels and nothing else', () => {
    const registry = new PanelRegistry()
    registry.register(descriptor('mail', '邮件'))
    // Nothing else — no profile enumeration exists to leak in.
    expect(panelRows(registry.getSnapshot(), []).map((entry) => entry.id)).toEqual(['mail'])
  })

  it('drops a panel its own plugin withdrew', () => {
    const registry = new PanelRegistry()
    const off = registry.register(descriptor('mail', '邮件'))
    registry.register(descriptor('notes', '笔记'))
    off()
    expect(panelRows(registry.getSnapshot(), []).map((entry) => entry.id)).toEqual(['notes'])
  })

  it('reads the title lazily, so a locale switch shows the new one', () => {
    const registry = new PanelRegistry()
    let title = '邮件'
    registry.register({ id: 'mail', title: () => title, render: () => null })
    expect(panelRows(registry.getSnapshot(), [])[0]?.title).toBe('邮件')
    title = 'Mail'
    expect(panelRows(registry.getSnapshot(), [])[0]?.title).toBe('Mail')
  })

  it('keeps pinned rows first', () => {
    const registry = new PanelRegistry()
    registry.register(descriptor('a', 'A', { order: 1 }))
    registry.register(descriptor('b', 'B', { order: 2 }))
    registry.register(descriptor('c', 'C', { order: 3 }))
    const rows = panelRows(registry.getSnapshot(), ['c'])
    expect(rows.map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    expect(rows[0]?.pinned).toBe(true)
  })

  it('carries a description and keywords only when the plugin declared them', () => {
    const registry = new PanelRegistry()
    registry.register(descriptor('mail', '邮件', { description: () => '读邮件', keywords: () => ['imap'] }))
    registry.register(descriptor('notes', '笔记'))
    const rows = panelRows(registry.getSnapshot(), [])
    // Looked up by id: two panels with no declared order tie-break on title, and
    // the collation of two Chinese titles is not this test's subject.
    expect(rows.find((entry) => entry.id === 'mail')).toMatchObject({ description: '读邮件', keywords: ['imap'] })
    expect(rows.find((entry) => entry.id === 'notes')?.description).toBeUndefined()
  })
})

describe('the workbench on screen', () => {
  it('draws the five views and marks the current one', () => {
    const { face } = shellFace([])
    render(<ConsoleShell {...face} />)
    for (const key of ['viewBoard', 'viewRules', 'viewFocus', 'viewConnectors', 'viewApps'] as const) {
      expect(screen.getByRole('button', { name: t(key) })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: t('viewBoard') }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: t('viewRules') }).getAttribute('aria-current')).toBeNull()
  })

  it('draws the panels only in the apps view', () => {
    const { face } = shellFace([row('mail', '邮件'), row('notes', '笔记')])
    render(<ConsoleShell {...face} />)
    // 看板是第一屏：面板目录降级成第四个视图，不再抢首屏。
    expect(screen.queryByRole('button', { name: '邮件' })).toBeNull()
    openApps()
    expect(screen.getByRole('button', { name: '邮件' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '笔记' })).toBeTruthy()
  })

  it('goes to the focus page through the layout, not by drawing it in place', () => {
    // 决策 Q1：聚焦是**第二个 main panel**，所以点它必须是一次 selectPanel。
    const { face, calls } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('viewFocus') }))
    expect(calls.nav).toEqual(['focus'])
  })

  it('says why a view could not be reached', () => {
    // 同面板打开的老坑：`selectPanel` 会抛，吞掉就只剩「点了没反应」。
    const { face } = shellFace([], [], [], [], {
      navigateOutcome: { ok: false, message: 'layout.selectPanel: main panel "console-focus" is not registered' },
    })
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('viewFocus') }))
    expect(screen.getByText(new RegExp(t('viewFailed')))).toBeTruthy()
    expect(screen.getByText(/is not registered/)).toBeTruthy()
  })

  it('draws the rules placeholder with its reason instead of fake buttons', () => {
    const { face } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('viewRules') }))
    expect(screen.getByText(t('rulesHint'))).toBeTruthy()
    expect(screen.getByText(t('rulesLater'))).toBeTruthy()
  })

  it('opens the row the user clicked', () => {
    const { face, calls } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    openApps()
    fireEvent.click(screen.getByRole('button', { name: '邮件' }))
    expect(calls.open).toEqual(['mail'])
  })

  it('says why a panel would not open instead of showing nothing', () => {
    // 这条盯的是一个真实故障：打开面板走的是布局的 `selectPanel`，它会抛；而工作台
    // 原先把抛吞掉了，于是「点进去什么也没有」——用户看不到任何原因。
    const { face } = shellFace(
      [row('mail', '邮件分诊')],
      [], [], [],
      { openOutcome: { ok: false, message: 'layout.selectPanel: main panel "mail" is not registered' } },
    )
    render(<ConsoleShell {...face} />)
    openApps()
    fireEvent.click(screen.getByRole('button', { name: '邮件分诊' }))

    expect(screen.getByText(new RegExp(t('openFailed')))).toBeTruthy()
    expect(screen.getByText(/is not registered/)).toBeTruthy()
  })

  it('narrows to the search term and restores the list when it is cleared', () => {
    const { face } = shellFace([row('mail', '邮件'), row('notes', '笔记')])
    render(<ConsoleShell {...face} />)
    openApps()
    const search = screen.getByRole('searchbox', { name: t('search') })
    fireEvent.change(search, { target: { value: '笔记' } })
    expect(screen.queryByText('邮件')).toBeNull()
    expect(screen.getByText('笔记')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByText('邮件')).toBeTruthy()
  })

  it('asks for the layout the user picked', () => {
    const { face, calls } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    openApps()
    fireEvent.click(screen.getByRole('tab', { name: t('layoutList') }))
    expect(calls.layout).toEqual(['list'])
  })

  it('pins a row from its action menu, without opening it', () => {
    const { face, calls } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    openApps()
    fireEvent.click(screen.getByRole('button', { name: t('cardActions') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('pin') }))
    expect(calls.pin).toEqual(['mail'])
    expect(calls.open).toEqual([])
  })

  it('explains an empty list rather than showing nothing', () => {
    const { face } = shellFace([])
    render(<ConsoleShell {...face} />)
    openApps()
    expect(screen.getByText(new RegExp(t('listEmpty')))).toBeTruthy()
  })

  it('offers the notices the Host stored behind the header button', () => {
    const notice: ConsoleNoticeRecord = { id: '1', title: '新邮件', tone: 'info', createdAt: 10, delivered: [], state: 'new' }
    const { face } = shellFace([row('mail', '邮件')], [notice])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeBadge', { count: 1 }) }))
    // 首页的注意力队列与通知面板都会显示它。
    expect(screen.getAllByText('新邮件').length).toBeGreaterThan(0)
  })

  it('puts what needs the user above the plugin list', () => {
    const waiting: ConsoleNoticeRecord = {
      id: 'run-9',
      title: '这封推广邮件建议归档',
      body: '规则「推广与电子报」建议执行 move',
      createdAt: 10,
      delivered: [],
      state: 'new',
      kind: 'mail',
      source: 'mail',
      actions: [{ id: 'apply', label: '执行' }],
    }
    const { face, calls } = shellFace([row('mail', '邮件')], [waiting])
    render(<ConsoleShell {...face} />)

    // 队列是首屏内容，不需要先点开通知面板。
    expect(screen.getByText('这封推广邮件建议归档')).toBeTruthy()
    expect(screen.getByText(t('attentionCount', { count: 1 }))).toBeTruthy()
    // 队列里的按钮直接可用。
    fireEvent.click(screen.getAllByRole('button', { name: '执行' })[0] as HTMLElement)
    expect(calls.acted).toEqual(['run-9:apply'])
  })

  it('shows what the automations did, separately from what needs a decision', () => {
    const logged: ConsoleLogEntry[] = [
      { id: 'l-1', at: 20, source: 'mail', title: '按「推广与电子报」处理了：限时优惠', detail: '已标记为已读；已移动到「推广」', ok: true },
    ]
    const { face } = shellFace([row('mail', '邮件')], [], [], logged)
    render(<ConsoleShell {...face} />)

    expect(screen.getByText(t('automationLog'))).toBeTruthy()
    expect(screen.getByText('按「推广与电子报」处理了：限时优惠')).toBeTruthy()
    // 它不该被算成待处理：日志与队列是两件事。
    expect(screen.getByText(t('attentionClear'))).toBeTruthy()
  })

  it('says so plainly when nothing is waiting', () => {
    const { face } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    expect(screen.getByText(t('attentionClear'))).toBeTruthy()
    expect(screen.getByText(t('attentionEmpty'))).toBeTruthy()
  })

  it('draws an item\'s actions and hands the click back by id', async () => {
    const item: ConsoleNoticeRecord = {
      id: 'run-1',
      title: '建议归档这封推广邮件',
      tone: 'info',
      createdAt: 10,
      delivered: [],
      state: 'new',
      kind: 'mail',
      actions: [{ id: 'apply', label: '执行' }, { id: 'skip', label: '不用' }],
    }
    const { face, calls } = shellFace([row('mail', '邮件')], [item])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeBadge', { count: 1 }) }))
    // 同一个条目现在会在两处出现（首页的注意力队列、通知面板），所以按面板作用域查。
    const panel = screen.getByRole('dialog')
    fireEvent.click(within(panel).getByRole('button', { name: '执行' }))
    // 页面不认识动作的含义，只把 (条目 id, 动作 id) 交出去。
    expect(calls.acted).toEqual(['run-1:apply'])
  })

  it('lets the user dismiss an item, and shows a handled one as such', async () => {
    const pending: ConsoleNoticeRecord = {
      id: 'run-2',
      title: '要处理一下',
      createdAt: 10,
      delivered: [],
      state: 'new',
      kind: 'mail',
      actions: [{ id: 'apply', label: '执行' }],
    }
    const done: ConsoleNoticeRecord = {
      id: 'run-3',
      title: '已经处理完了',
      createdAt: 20,
      delivered: [],
      state: 'resolved',
    }
    const { face, calls } = shellFace([row('mail', '邮件')], [pending, done])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeBadge', { count: 1 }) }))

    const panel = screen.getByRole('dialog')
    fireEvent.click(within(panel).getByRole('button', { name: t('noticeDismiss') }))
    expect(calls.dismissed).toEqual(['run-2'])
    // 已处理的条目不画动作按钮，只标一个状态（两处都会标，所以用 getAllByText）。
    expect(screen.getAllByText(t('noticeDone')).length).toBeGreaterThan(0)
  })

  it('portals the notice panel out of the header, on the shared fixed frame', () => {
    // The surface leaves the header's subtree (no ancestor filter can become
    // its fixed-position containing block) and carries the fixed frame itself.
    const { face } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeTitle') }))
    const panel = screen.getByRole('dialog', { name: t('noticeTitle') })
    expect(panel.classList.contains('dshc-notice-panel')).toBe(true)
    expect(document.body.contains(panel)).toBe(true)
    expect(panel.closest('header')).toBeNull()
  })

  it('keeps the notice panel inside the viewport when the trigger sits at the edge', () => {
    // The regression this guards: a surface that is mounted only *after* it has
    // coordinates gets measured as 0×0 on the first commit, so `align: 'end'`
    // places it at the anchor's right edge and the real 320px panel hangs off
    // the screen. jsdom reports no layout at all, so the two facts the clamp
    // reads are stubbed here; everything else is the real component.
    const restore = stubLayout({ panelWidth: 320, panelHeight: 360, viewport: [1440, 900], anchor: { left: 1300, right: 1416, top: 18, bottom: 46 } })
    try {
      const { face } = shellFace([row('mail', '邮件')])
      render(<ConsoleShell {...face} />)
      fireEvent.click(screen.getByRole('button', { name: t('noticeTitle') }))
      const panel = screen.getByRole('dialog', { name: t('noticeTitle') })
      const left = Number.parseFloat(panel.style.left)
      const top = Number.parseFloat(panel.style.top)
      // Right-aligned under the trigger, then clamped to the 12px margin: both
      // the panel's edges stay inside the viewport. Without the fix the panel is
      // placed at the anchor's right edge (1416) while its real width is 320, so
      // `left + width` overruns the viewport by 296px.
      expect(left + 320).toBeLessThanOrEqual(1440 - 12)
      expect(left).toBeGreaterThanOrEqual(12)
      expect(top + 360).toBeLessThanOrEqual(900 - 12)
      expect(panel.style.visibility).not.toBe('hidden')
    } finally {
      restore()
    }
  })

  it('closes the notice panel on Escape', () => {
    const { face } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeTitle') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: t('noticeTitle') })).toBeNull()
  })

  it('closes the notice panel on an outside pointerdown', () => {
    const { face } = shellFace([row('mail', '邮件')])
    render(<ConsoleShell {...face} />)
    fireEvent.click(screen.getByRole('button', { name: t('noticeTitle') }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: t('noticeTitle') })).toBeNull()
  })
})

describe('search and notice helpers', () => {
  it('matches title, description and keywords', () => {
    const rows = [row('a', '邮件', { description: 'IMAP' }), row('b', '笔记', { keywords: ['note', '草稿'] })]
    expect(filterPanels(rows, '邮件').map((entry) => entry.id)).toEqual(['a'])
    expect(filterPanels(rows, 'imap').map((entry) => entry.id)).toEqual(['a'])
    expect(filterPanels(rows, '草稿').map((entry) => entry.id)).toEqual(['b'])
    expect(filterPanels(rows, '   ').map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('keeps one row per notice id, newest first', () => {
    const older: ConsoleNoticeRecord = { id: '1', title: '旧', tone: 'info', createdAt: 10, delivered: [], state: 'new' }
    const newer: ConsoleNoticeRecord = { id: '2', title: '新', tone: 'info', createdAt: 20, delivered: [], state: 'new' }
    expect(mergeNotices([older], [newer, older]).map((notice) => notice.id)).toEqual(['2', '1'])
  })
})

describe('the notification row', () => {
  /** The three shipped channels, all on. */
  const channels: ChannelInfo[] = [
    { id: 'desktop', enabled: true },
    { id: 'inapp', enabled: true },
    { id: 'sound', enabled: true },
  ]

  /** Open the row's multi-select and return the menu it rendered. */
  const openMenu = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: t('settingsTitle') }))
    return screen.getByRole('menu')
  }

  it('writes the selection the user left', async () => {
    const save = vi.fn(() => Promise.resolve(true))
    render(<ConsoleSettingsRow t={t} useChannels={() => channels} saveChannels={save} useDesktopBlocked={() => undefined} />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: t('channelSound') }))
    expect(save).toHaveBeenCalledWith(['desktop', 'inapp'])
  })

  it('adds a channel back when the user picks it again', async () => {
    const save = vi.fn(() => Promise.resolve(true))
    render(<ConsoleSettingsRow
      t={t}
      useChannels={() => [{ id: 'inapp', enabled: true }, { id: 'sound', enabled: false }]}
      saveChannels={save}
      useDesktopBlocked={() => undefined}
    />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: t('channelSound') }))
    expect(save).toHaveBeenCalledWith(['inapp', 'sound'])
  })

  it('refuses to switch the last channel off', () => {
    const save = vi.fn(() => Promise.resolve(true))
    render(<ConsoleSettingsRow
      t={t}
      useChannels={() => [{ id: 'inapp', enabled: true }]}
      saveChannels={save}
      useDesktopBlocked={() => undefined}
    />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: t('channelInapp') }))
    expect(save).not.toHaveBeenCalled()
  })

  it('reports a refused write instead of pretending it saved', async () => {
    const save = vi.fn(() => Promise.resolve(false))
    render(<ConsoleSettingsRow t={t} useChannels={() => channels} saveChannels={save} useDesktopBlocked={() => undefined} />)
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: t('channelSound') }))
    expect(await screen.findByText(new RegExp(t('settingsFailed')))).toBeTruthy()
  })

  it('says why the desktop channel cannot reach the user', () => {
    render(<ConsoleSettingsRow
      t={t}
      useChannels={() => channels}
      saveChannels={vi.fn(() => Promise.resolve(true))}
      useDesktopBlocked={() => 'denied'}
    />)
    expect(screen.getByText(new RegExp(t('noticePermissionDenied')))).toBeTruthy()
  })
})
