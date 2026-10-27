/**
 * The workbench shell: header, view navigation, and whichever view is current.
 *
 * Two pages, one module. As `main:console` it hosts 看板 / 规则 / 连接器 / 应用 and
 * draws the plugin directory as the last of them; as `main:console-focus` it
 * draws the focus page. Both pages wear the same header and the same five-item
 * navigation, reading the current view from the same stored preference, so
 * moving between them does not flip a strip that is supposed to be stable.
 *
 * The navigation is embedded in the page rather than reached through the
 * sidebar: the sidebar opens the workbench once, and from there the views are
 * pages, not panels. 聚焦 is the exception — it is a real second main panel, so
 * selecting it is `ctx.layout.selectPanel`, which **throws** for a key the layout
 * does not consider registered. A click that fails silently reads as "the app is
 * broken", so the reason is shown under the navigation (the same treatment the
 * panel directory already gives its failures).
 *
 * @module @free-lzj/dsh-console/client/shell
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, MenuSurface, Tag, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConsoleLayout, ConsoleLogEntry, ConsoleNoticeRecord, ConsoleView, RunningSession,
} from '../protocol.ts'
import type { PanelRow } from './registry.ts'
import { FocusPage } from './focus.tsx'
import { ViewNav } from './nav.tsx'
import { RulesView, type TriageSource } from './rules.tsx'
import { AppsView, ConnectorsView } from './views.tsx'
import { BoardView, WorkbenchUnavailable, type WorkbenchFace } from './workbench/board.tsx'
import { AttentionQueue } from './attention.tsx'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

/** What opening one panel produced: success, or a reason worth showing. */
export interface PanelOutcome {
  readonly ok: boolean
  readonly message?: string
}

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
   * Selector hook over the view the workbench is on.
   *
   * A hook rather than a getter because picking a view repaints the page: the
   * stored value is the only thing that moved, and no other subscription here
   * would see it.
   */
  readonly useView: <S>(select: (view: ConsoleView) => S, equal?: (a: S, b: S) => boolean) => S
  /**
   * Go to one view.
   *
   * Returns an outcome rather than nothing: reaching 聚焦 goes through the
   * layout's `selectPanel`, which throws for a key it does not consider
   * registered, and a click that fails silently is worse than one that fails
   * loudly.
   */
  readonly navigate: (view: ConsoleView) => PanelOutcome
  /**
   * Open one panel.
   *
   * Same contract as {@link navigate}: opening goes through `selectPanel`, which
   * throws for a key it does not consider registered.
   */
  readonly open: (panel: PanelRow) => PanelOutcome
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
  /**
   * The board face, when the Host mounted a board. Optional so a workbench
   * without one — and every existing spec face — renders the home list alone.
   */
  readonly workbench?: WorkbenchFace
  /** The decision engine's public surface, wherever it currently lives. */
  readonly triage: TriageSource
}

/**
 * Props of a workbench page seat.
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
 * Draw the workbench page: the view the user is on, under the shared chrome.
 * @param props - the framework seat plus the injected face.
 * @returns the shell.
 */
export function ConsoleShell(props: ConsoleShellProps): ReactNode {
  const { t, useView, navigate, workbench } = props
  const current = useView((view) => view)
  const rows = props.useRows((all) => all)
  const notices = mergeNotices(props.useNotices((all) => all), props.liveNotices())
  /** 上一次导航或打开失败的原因；空串表示没有。 */
  const [failure, setFailure] = useState('')
  /** 把一句失败原因显示出来：空串表示没事了。 */
  const report = (label: string, detail: string | undefined): void => {
    setFailure(detail === undefined ? label : `${label}：${detail}`)
  }
  const go = (next: ConsoleView): void => {
    const outcome = navigate(next)
    if (outcome.ok) setFailure('')
    else report(t('viewFailed'), outcome.message)
  }
  // 布局不持久化：刷新后落回对话页，再进来时按存下的视图补一次跳转，否则「聚焦」
  // 会永远停在看板。只在挂载时对一次——之后的切换由导航自己负责。
  useEffect(() => {
    if (current !== 'focus') return
    const outcome = navigate('focus')
    if (!outcome.ok) report(t('viewFailed'), outcome.message)
    // 只跑一次：`current` 是挂载那一刻的值，正是要恢复的那个。
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={CLS.root}>
      <WorkbenchTop {...props} notices={notices} current={current} onSelect={go} />
      <div className={CLS.body}>
        {failure === '' ? null : <p className={CLS.openError} role="status">{failure}</p>}
        {current === 'board' && (
          <>
            {/*
              注意力队列排在看板上方：它是「现在要你决定的事」里不能变成卡片的那一半
              （插件的 notice 与条目）。看板的三列回答的是另一半。
            */}
            <AttentionQueue
              t={t}
              notices={notices}
              running={props.running}
              log={props.log}
              actOnItem={props.actOnItem}
              dismissItem={props.dismissItem}
            />
            {workbench === undefined ? <WorkbenchUnavailable t={t} /> : <BoardView face={workbench} t={t} />}
          </>
        )}
        {current === 'rules' && <RulesView t={t} triage={props.triage} />}
        {current === 'connectors' && (workbench === undefined
          ? <WorkbenchUnavailable t={t} />
          : <ConnectorsView face={workbench} t={t} />)}
        {current === 'apps' && (
          <AppsView
            t={t}
            panels={rows}
            layout={props.layout()}
            onOpen={(panel) => {
              const outcome = props.open(panel)
              if (outcome.ok) setFailure('')
              else report(t('openFailed'), outcome.message)
            }}
            onTogglePin={props.togglePin}
            setLayout={props.setLayout}
          />
        )}
        {current === 'focus' && <p className={CLS.viewMeta}>{t('viewFocusSwitched')}</p>}
      </div>
    </div>
  )
}

/**
 * Draw the focus page under the same chrome.
 * @param props - the framework seat plus the injected face.
 * @returns the focus page.
 */
export function FocusShell(props: ConsoleShellProps): ReactNode {
  const { t, useView, navigate } = props
  const current = useView((view) => view)
  const notices = mergeNotices(props.useNotices((all) => all), props.liveNotices())
  const [failure, setFailure] = useState('')
  const go = (next: ConsoleView): void => {
    const outcome = navigate(next)
    setFailure(outcome.ok ? '' : (outcome.message === undefined ? t('viewFailed') : `${t('viewFailed')}：${outcome.message}`))
  }
  return (
    <div className={CLS.root}>
      <WorkbenchTop {...props} notices={notices} current={current} onSelect={go} />
      <div className={CLS.body}>
        {failure === '' ? null : <p className={CLS.openError} role="status">{failure}</p>}
        <FocusPage
          t={t}
          running={props.running}
          waitingOn={sessionId => notices.some(notice => notice.state === 'new' && notice.sessionId === sessionId)}
        />
      </div>
    </div>
  )
}

/**
 * The header and the view navigation both pages wear.
 *
 * One component rather than two copies: the design brief asks for the two pages
 * to look and behave identically here, and two copies drift the first time one
 * of them is edited.
 * @param props - the translate seat, the notices, the current view, and the actions.
 * @returns the header and the navigation.
 */
function WorkbenchTop(props: ConsoleShellProps & {
  readonly notices: readonly ConsoleNoticeRecord[]
  readonly current: ConsoleView
  readonly onSelect: (view: ConsoleView) => void
}): ReactNode {
  return (
    <>
      <header className={CLS.header}>
        <h1 className={CLS.title}>{props.t('title')}</h1>
        <div className={CLS.tools}>
          <NoticeButton
            t={props.t}
            notices={props.notices}
            awaiting={props.awaiting()}
            onClear={props.clearNotices}
            actOnItem={props.actOnItem}
            dismissItem={props.dismissItem}
          />
        </div>
      </header>
      <ViewNav current={props.current} t={props.t} onSelect={props.onSelect} />
    </>
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
