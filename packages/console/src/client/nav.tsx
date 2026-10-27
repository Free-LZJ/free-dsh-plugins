/**
 * The five-view navigation under the workbench header.
 *
 * The visual spec is the conversation page's own tab strip, copied field for
 * field — flex, `gap: 36px`, 13/16 at weight 500, `--dsw-alias-label-tertiary`
 * for the rest and `--dsw-alias-state-business-primary` plus a 2px underline for
 * the current one.
 *
 * What it deliberately is **not** is a `tablist`: `rules/plugin-ui.md` reserves
 * that role (and its arrow-key contract) for `ui-primitives`, and the shared
 * primitive that owns it — `SegmentedTabs` — is an equal-width slider, not this
 * left-aligned strip. So these are plain `Button`s carrying `aria-current`, and
 * the keyboard path is the native Tab/Enter one a button already has. That keeps
 * the appearance faithful without claiming a semantic the controls do not
 * implement.
 *
 * @module @free-lzj/dsh-console/client/nav
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CONSOLE_VIEWS, type ConsoleView } from '../protocol.ts'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

/** Locale key naming one view. */
export function viewLabelKey(view: ConsoleView): Parameters<Translate>[0] {
  switch (view) {
    case 'rules': return 'viewRules'
    case 'focus': return 'viewFocus'
    case 'connectors': return 'viewConnectors'
    case 'apps': return 'viewApps'
    default: return 'viewBoard'
  }
}

/**
 * Draw the view navigation.
 *
 * Both main panels draw it from the same source of truth (`currentView` on the
 * Host snapshot), so the strip does not flicker between two ideas of "where am
 * I" as the user moves between the workbench and the focus page.
 * @param props.current - the view the workbench is on.
 * @param props.t - the translate seat.
 * @param props.onSelect - called with the view the user picked.
 * @returns the navigation strip.
 */
export function ViewNav(props: {
  readonly current: ConsoleView
  readonly t: Translate
  readonly onSelect: (view: ConsoleView) => void
}): ReactNode {
  return (
    <nav className={CLS.nav} aria-label={props.t('viewNav')}>
      {CONSOLE_VIEWS.map((view) => (
        <Button
          key={view}
          variant="ghost"
          className={view === props.current ? `${CLS.navItem} ${CLS.navItemActive}` : CLS.navItem}
          aria-current={view === props.current ? 'page' : undefined}
          onClick={() => props.onSelect(view)}
        >
          {props.t(viewLabelKey(view))}
        </Button>
      ))}
    </nav>
  )
}
