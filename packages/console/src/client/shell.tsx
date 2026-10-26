/**
 * The workbench shell: everything that is *not* a plugin panel.
 *
 * Two seats, one module. As `main:console` it draws the home list — header,
 * search, layout control, notice centre, the chosen layout. As the sidebar row
 * it draws only the glyph; the shell forwards its click to `selectPanel`
 * itself, so the row the shell already renders opens the workbench like any
 * other panel and no second navigation path exists.
 *
 * The header mirrors the conversation page's top bar — same geometry, same
 * `--dsw-alias-border-l3` rule — and every control in it is a shared primitive,
 * so the workbench sits in the shell's visual language rather than beside it
 * (`rules/plugin-ui.md`).
 *
 * @module @free-lzj/dsh-console/client/shell
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconSearchOutlineRegular, Input, MenuSurface, SegmentedControl, Tag,
  useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConsoleLayout, ConsoleLogEntry, ConsoleNoticeRecord, RunningSession } from '../protocol.ts'
import { LAYOUTS, LAYOUT_ORDER, type HomeListProps } from './home.tsx'
import { AttentionQueue } from './attention.tsx'
import type { Translate } from './locales.ts'
import type { PanelRow } from './registry.ts'
import { CLS } from './styles.ts'

/** Everything the shell reads and calls, injected by the plugin's `apply`. */
export interface ShellInjected {
  /** Selector hook over the home-list rows (adopted panels joined with the stored preferences). */
  readonly useRows: <S>(select: (rows: readonly PanelRow[]) => S, equal?: (a: S, b: S) => boolean) => S
  /** Selector hook over the Host snapshot's notice list. */
  readonly useNotices: <S>(select: (notices: readonly ConsoleNoticeRecord[]) => S, equal?: (a: S, b: S) => boolean) => S
  /**
   * How many items still want the user, as the Host counts it.
   *
   * Read from the Host rather than counted here so every surface agrees, and so an
   * item snoozed until tomorrow is not silently shown as pending.
   */
  readonly awaiting: () => number
  /** The sessions working right now, as the Host last refreshed them. */
  readonly running: () => readonly RunningSession[]
  /** What automations did on their own, newest first. */
  readonly log: () => readonly ConsoleLogEntry[]
  /** The layout the user saved on the Host. */
  readonly layout: () => ConsoleLayout
  /**
   * Open one panel.
   *
   * Returns an outcome rather than nothing: opening goes through the layout's
   * `selectPanel`, which **throws** for a key it does not consider registered, and a
   * click that fails silently is worse than one that fails loudly.
   */
  readonly open: (panel: PanelRow) => { readonly ok: boolean; readonly message?: string }
  /** Pin or unpin one row. */
  readonly togglePin: (panel: PanelRow) => void
  /** Save the chosen layout. */
  readonly setLayout: (layout: ConsoleLayout) => void
  /** Ask the Host to drop the notice list. */
  readonly clearNotices: () => void
  /**
   * Tell the Host the user picked an action on one item.
   *
   * The page does not know what the action means: it hands back the item id and the
   * action id, and the Host routes them to the plugin that raised the item.
   */
  readonly actOnItem: (id: string, actionId: string) => Promise<{ ok: boolean; message?: string }>
  /** Tell the Host the user said "not my problem". */
  readonly dismissItem: (id: string) => Promise<{ ok: boolean; message?: string }>
  /** Notices raised while this page is open, newest first. */
  readonly liveNotices: () => readonly ConsoleNoticeRecord[]
}

/**
 * Props of the `main:console` seat.
 *
 * Declared as what the shell *reads* rather than as the framework's whole
 * composed seat: a component taking a subset of the props is the documented
 * assignability direction, and it keeps the shell drivable by a spec without
 * reconstructing the standard kit.
 */
export type ConsoleShellProps = { readonly t: Translate } & ShellInjected

/**
 * The unplaced surface: hidden but laid out, so the placement effect can read
 * real `offsetWidth`/`offsetHeight` in the commit that opened it.
 *
 * The shared `Menu` keeps the same constant for the same reason; a surface that
 * skips this frame gets measured as 0×0 and lands outside the viewport.
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Draw the workbench home.
 * @param props - the framework seat plus the injected face.
 * @returns the shell.
 */
export function ConsoleShell(props: ConsoleShellProps): ReactNode {
  const { t, useRows, useNotices, awaiting, running, log, layout, open, togglePin, setLayout, clearNotices, actOnItem, dismissItem, liveNotices } = props
  const rows = useRows((all) => all)
  const stored = useNotices((all) => all)
  const [query, setQuery] = useState('')
  /** 上一次「打开面板」失败的原因；空串表示没有。 */
  const [openError, setOpenError] = useState('')
  const current = layout()
  const Layout = LAYOUTS[current]
  const notices = mergeNotices(stored, liveNotices())
  const homeProps: HomeListProps = {
    panels: filterPanels(rows, query),
    t,
    // 打开失败要说出来：静默的失败让人以为是「这个插件坏了」，而真正的原因
    // （这个面板没在 `main` 槽里生效）是能修的。
    onOpen: (panel) => {
      const outcome = open(panel)
      setOpenError(outcome.ok ? '' : (outcome.message ?? t('openFailed')))
    },
    onTogglePin: togglePin,
    emptyTitle: rows.length === 0 ? t('listEmpty') : t('searchEmpty'),
    emptyHint: rows.length === 0 ? t('listEmptyHint') : t('searchEmptyHint'),
  }
  return (
    <div className={CLS.root}>
      <header className={CLS.header}>
        <h1 className={CLS.title}>{t('title')}</h1>
        <div className={CLS.tools}>
          <Input
            className={CLS.search}
            type="search"
            icon={<IconSearchOutlineRegular />}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <SegmentedControl
            id="dsh-console-layout"
            value={current}
            label={t('layout')}
            options={LAYOUT_ORDER.map((name) => ({
              value: name,
              label: t(name === 'grid' ? 'layoutGrid' : name === 'list' ? 'layoutList' : 'layoutCompact'),
            }))}
            onChange={(next: ConsoleLayout) => setLayout(next)}
          />
          <NoticeButton
            t={t}
            notices={notices}
            awaiting={awaiting()}
            onClear={clearNotices}
            actOnItem={actOnItem}
            dismissItem={dismissItem}
          />
        </div>
      </header>
      <div className={CLS.body}>
        {openError === '' ? null : (
          <p className={CLS.openError} role="status">{t('openFailed')}：{openError}</p>
        )}
        {/* 注意力队列排在最上面：首页要回答的是「现在需要我决定什么」，插件目录是手段。 */}
        <AttentionQueue t={t} notices={notices} running={running} log={log} actOnItem={actOnItem} dismissItem={dismissItem} />
        <h2 className={CLS.attentionSubheading}>{t('panelsHeading')}</h2>
        <Layout {...homeProps} />
      </div>
    </div>
  )
}

/**
 * The notice centre: a toolbar button with an unread badge, opening the list.
 *
 * The list is custom content rather than menu rows, so it wears the shared menu
 * material (`MenuSurface`) and rides the shared anchor tracking and dismissal —
 * the pieces `Menu` itself is built from, so this does not re-implement a
 * popover.
 *
 * Three details are the shared pattern rather than local choices, and each one
 * is load-bearing:
 *
 * - the surface mounts in the **same commit** that opens it, hidden, so the
 *   placement effect can measure real dimensions before the first paint. Gating
 *   it on the coordinates would measure a missing panel as 0×0 and place it off
 *   the viewport edge;
 * - it is **portaled**, so no ancestor's filter, backdrop-filter or transform can
 *   become its fixed-position containing block;
 * - outside pointerdown and Escape close it.
 *
 * @param props - the translate seat, the notices, and the clear command.
 * @returns the button and its popover.
 */
function NoticeButton({ t, notices, awaiting, onClear, actOnItem, dismissItem }: {
  readonly t: Translate
  readonly notices: readonly ConsoleNoticeRecord[]
  readonly awaiting: number
  readonly onClear: () => void
  readonly actOnItem: ShellInjected['actOnItem']
  readonly dismissItem: ShellInjected['dismissItem']
}): ReactNode {
  const [open, setOpen] = useState(false)
  /**
   * Why the last click did not take.
   *
   * Kept in the panel rather than pushed to a toast: the failure belongs next to the
   * item it is about, and the item is still sitting right there.
   */
  const [failure, setFailure] = useState('')
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, align: 'end', gap: 6, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])
  /** 跑一次点击，失败就把原因显示在面板里。 */
  const run = (work: Promise<{ ok: boolean; message?: string }>): void => {
    setFailure('')
    void work.then((result) => {
      if (!result.ok) setFailure(result.message ?? t('noticeFailed'))
    })
  }
  return (
    <span ref={rootRef}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={awaiting === 0 ? t('noticeTitle') : t('noticeBadge', { count: awaiting })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value) }}
      >
        {t('noticeTitle')}
        {awaiting > 0 && <Tag tone="info">{awaiting}</Tag>}
      </Button>
      {open && createPortal(
        <MenuSurface
          ref={panelRef}
          className={CLS.noticePanel}
          style={position ?? MEASURE_STYLE}
          role="dialog"
          aria-label={t('noticeTitle')}
        >
          <div className={CLS.noticeList}>
            {notices.length === 0 && <p className={CLS.empty}>{t('noticeEmpty')}</p>}
            {failure !== '' && <p className={CLS.noticeFailure} role="status">{failure}</p>}
            {notices.map((notice) => (
              <div key={notice.id} className={`${CLS.notice} ${toneClass(notice.tone)}`}>
                <span className={CLS.noticeTitle}>{notice.title}</span>
                {notice.body !== undefined && <span className={CLS.noticeBody}>{notice.body}</span>}
                {notice.state === 'resolved' && <Tag tone="success">{t('noticeDone')}</Tag>}
                {notice.state === 'dismissed' && <Tag tone="outline">{t('noticeDismissed')}</Tag>}
                {notice.actions !== undefined && notice.state === 'new' && (
                  <span className={CLS.noticeActions}>
                    {notice.actions.map((action) => (
                      <Button
                        key={action.id}
                        size="sm"
                        onClick={() => { run(actOnItem(notice.id, action.id)) }}
                      >
                        {action.label}
                      </Button>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { run(dismissItem(notice.id)) }}
                    >
                      {t('noticeDismiss')}
                    </Button>
                  </span>
                )}
                <span className={CLS.noticeTime}>{new Date(notice.createdAt).toLocaleTimeString()}</span>
              </div>
            ))}
            {notices.length > 0 && (
              <div className={CLS.noticeFoot}>
                <Button variant="ghost" size="sm" onClick={onClear}>{t('noticeClear')}</Button>
              </div>
            )}
          </div>
        </MenuSurface>,
        document.body,
      )}
    </span>
  )
}

/**
 * The sidebar row's glyph.
 * @param props - requested edge and selection; the shell owns the label.
 * @returns the workbench glyph.
 */
export function ConsoleIcon({ size }: { readonly size: number; readonly active?: boolean }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  )
}

/** @param tone - the notice tone. @returns the class the stylesheet colours it with. */
function toneClass(tone: ConsoleNoticeRecord['tone']): string {
  if (tone === 'success') return CLS.noticeSuccess
  if (tone === 'warn') return CLS.noticeWarn
  if (tone === 'error') return CLS.noticeError
  return ''
}

/**
 * The rows the home list draws, filtered by the search box.
 * @param panels - every row.
 * @param query - the search text.
 * @returns the matching rows, order preserved.
 */
export function filterPanels(panels: readonly PanelRow[], query: string): readonly PanelRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return panels
  return panels.filter((panel) => [panel.title, panel.description ?? '', ...(panel.keywords ?? [])]
    .join(' ')
    .toLowerCase()
    .includes(needle))
}

/**
 * Merge the Host's stored notices with the ones this page heard directly.
 *
 * The stream is the fast path; the stored list is the truth after a reload. A
 * notice that reached both is one row, keyed by its id.
 * @param stored - notices the Host returned with its snapshot.
 * @param live - notices this page received from the stream.
 * @returns newest first, without duplicates.
 */
export function mergeNotices(
  stored: readonly ConsoleNoticeRecord[],
  live: readonly ConsoleNoticeRecord[],
): readonly ConsoleNoticeRecord[] {
  const byId = new Map<string, ConsoleNoticeRecord>()
  for (const notice of [...live, ...stored]) {
    if (!byId.has(notice.id)) byId.set(notice.id, notice)
  }
  return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt)
}
