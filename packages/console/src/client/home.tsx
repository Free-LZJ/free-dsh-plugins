/**
 * The home list, in its three layouts.
 *
 * A layout is a **strategy** over the same {@link PanelRow} array, and which one
 * renders is the user's saved preference; nothing about a layout leaks into the
 * registry, the Host or another layout. Adding a fourth is a new function in
 * `LAYOUTS` plus a label, which is exactly why they share one props shape.
 *
 * Every card uses the settings-card material and the shared controls (the pin
 * action is a `Menu`, not a hand-drawn star), so the list reads like the rest of
 * DSH — see `rules/plugin-ui.md`.
 *
 * @module @free-lzj/dsh-console/client/home
 */

import { useState, type ReactNode } from 'react'
import {
  Button, IconEllipsisOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, Menu, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConsoleLayout } from '../protocol.ts'
import type { Translate } from './locales.ts'
import type { PanelRow } from './registry.ts'
import { CLS } from './styles.ts'

/** What every layout receives. */
export interface HomeListProps {
  /** Rows to draw, already filtered and ordered. */
  readonly panels: readonly PanelRow[]
  readonly t: Translate
  /** Open one panel. */
  readonly onOpen: (panel: PanelRow) => void
  /** Pin or unpin one panel. */
  readonly onTogglePin: (panel: PanelRow) => void
  readonly emptyTitle: string
  readonly emptyHint: string
}

/** One layout implementation. */
export type HomeLayout = (props: HomeListProps) => ReactNode

/**
 * The per-card action menu: the shared `Menu` over one `MenuItemButton`, the way
 * every DSH row carries its own "⋯" actions.
 *
 * A real component rather than a helper, because it owns an `open` state: one
 * hook scope per card, so a filtered list does not change how many hooks the
 * layout calls.
 * @param props.root - the list props.
 * @param props.panel - the row the menu acts on.
 * @returns the menu, anchored on a ghost icon button.
 */
function CardActions({ root, panel }: { readonly root: HomeListProps; readonly panel: PanelRow }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <span className={CLS.cardActions}>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        align="end"
        portal
        anchor={(
          <Button
            variant="ghost"
            size="sm"
            icon={<IconEllipsisOutlineRegular />}
            aria-label={root.t('cardActions')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          />
        )}
      >
        <MenuItemButton
          icon={panel.pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
          onSelect={() => {
            setOpen(false)
            root.onTogglePin(panel)
          }}
        >
          {panel.pinned ? root.t('unpin') : root.t('pin')}
        </MenuItemButton>
      </Menu>
    </span>
  )
}

/**
 * The glyph a row shows: the plugin's own, or the first letter of its title.
 * @param panel - the row.
 * @returns the glyph node.
 */
function glyph(panel: PanelRow): ReactNode {
  if (panel.icon !== undefined && panel.icon !== null) return panel.icon
  return <span aria-hidden="true">{panel.title.slice(0, 1).toUpperCase()}</span>
}

/** The empty state every layout shares. */
function empty(props: HomeListProps): ReactNode {
  return (
    <p className={CLS.empty}>
      {props.emptyTitle}
      <br />
      {props.emptyHint}
    </p>
  )
}

/**
 * One card: the card material, a stretched open button, and the action menu.
 * @param props - the list props.
 * @param panel - the row.
 * @param withDescription - whether this layout shows the description.
 * @returns the card.
 */
function card(props: HomeListProps, panel: PanelRow, withDescription: boolean): ReactNode {
  return (
    <li key={panel.id} className={CLS.card}>
      <button
        type="button"
        className={CLS.cardOpen}
        onClick={() => props.onOpen(panel)}
        aria-label={panel.title}
      >
        <span className={CLS.cardMain}>
          <span className={CLS.cardIcon}>{glyph(panel)}</span>
          <span className={CLS.cardTitle}>{panel.title}</span>
        </span>
        {withDescription && panel.description !== undefined && (
          <p className={CLS.cardDesc}>{panel.description}</p>
        )}
      </button>
      <CardActions root={props} panel={panel} />
    </li>
  )
}

/** The card grid: the default, and the one that shows a description. */
export const gridLayout: HomeLayout = (props) => {
  if (props.panels.length === 0) return empty(props)
  return <ul className={CLS.cards}>{props.panels.map((panel) => card(props, panel, true))}</ul>
}

/** One row per panel: the densest layout that still keeps a description. */
export const listLayout: HomeLayout = (props) => {
  if (props.panels.length === 0) return empty(props)
  return <ul className={CLS.list}>{props.panels.map((panel) => card(props, panel, true))}</ul>
}

/** Icon-and-title tiles: many panels, as little vertical space as possible. */
export const compactLayout: HomeLayout = (props) => {
  if (props.panels.length === 0) return empty(props)
  return <ul className={CLS.compact}>{props.panels.map((panel) => card(props, panel, false))}</ul>
}

/** The layouts a user can choose between, keyed by the value the Host saves. */
export const LAYOUTS: Readonly<Record<ConsoleLayout, HomeLayout>> = {
  grid: gridLayout,
  list: listLayout,
  compact: compactLayout,
}

/** The layout order the header control lists, with the default first. */
export const LAYOUT_ORDER: readonly ConsoleLayout[] = ['grid', 'list', 'compact']
