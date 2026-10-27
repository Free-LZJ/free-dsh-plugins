/**
 * The three content views the workbench shows beside the board: 规则, 连接器 and
 * 应用.
 *
 * Two of them are honest about where they are. **规则** is a placeholder with a
 * reason: the decision core (rule file, condition and action registries, hit
 * records, undo window) moves into the workbench in P1b, so until then this view
 * offers the one thing it really has — the board's routing-table version — and
 * says plainly that there is nothing to edit. **连接器** is real capability that
 * already exists: the connector metadata the board advertises, plus the event
 * simulator, which is marked as a debug tool rather than a product feature.
 *
 * **应用** is the old home page's reason for existing, demoted from the whole
 * workbench body to one view: the panel directory, with its three layouts and
 * its search. Nothing about it changed except where it lives.
 *
 * @module @free-lzj/dsh-console/client/views
 */

import { useState, type ReactNode } from 'react'
import { IconSearchOutlineRegular, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConsoleLayout } from '../protocol.ts'
import type { Translate } from './locales.ts'
import { filterPanels, type PanelRow } from './registry.ts'
import { LAYOUTS, LAYOUT_ORDER, type HomeListProps } from './home.tsx'
import { CLS } from './styles.ts'
import type { WorkbenchFace } from './workbench/board.tsx'
import { WorkbenchSimulator } from './workbench/simulator.tsx'

/**
 * Draw the rules view.
 * @param props.t - the translate seat.
 * @param props.face - the board face, when the Host mounted one.
 * @returns the placeholder, plus the one fact that already exists.
 */
export function RulesView({ t, face }: {
  readonly t: Translate
  readonly face?: WorkbenchFace | undefined
}): ReactNode {
  return (
    <section className={CLS.view}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{t('rulesTitle')}</h2>
        <p className={CLS.viewHint}>{t('rulesHint')}</p>
      </header>
      {face !== undefined && <RoutingVersion face={face} t={t} />}
      <p className={CLS.viewEmpty}>{t('rulesLater')}</p>
    </section>
  )
}

/**
 * The routing-table version the board is currently deciding with.
 *
 * A component of its own because it calls a selector hook, and a hook may not be
 * called conditionally from the view that may or may not have a face.
 * @param props.face - the board face.
 * @param props.t - the translate seat.
 * @returns the version line, or nothing before the first snapshot.
 */
function RoutingVersion({ face, t }: { readonly face: WorkbenchFace; readonly t: Translate }): ReactNode {
  const state = face.useBoard((current) => current)
  if (state === undefined) return null
  return <p className={CLS.viewMeta}>{t('routingVersion', { version: state.routingVersion })}</p>
}

/**
 * Draw the connectors view: what comes in, what goes out, and the debug simulator.
 * @param props.t - the translate seat.
 * @param props.face - the board face (the connectors are the board's own list).
 * @returns the connectors, their routing version, and the simulator.
 */
export function ConnectorsView({ t, face }: {
  readonly t: Translate
  readonly face: WorkbenchFace
}): ReactNode {
  const state = face.useBoard((current) => current)
  return (
    <section className={CLS.view}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{t('connectorsTitle')}</h2>
        <p className={CLS.viewHint}>{t('connectorsHint')}</p>
      </header>
      {state === undefined
        ? <p className={CLS.viewEmpty}>{t('boardLoading')}</p>
        : (
          <>
            <ul className={CLS.connectorList}>
              {state.connectors.map((connector) => (
                <li key={connector.id} className={CLS.connectorItem}>
                  <span className={CLS.connectorName}>{connector.label}</span>
                  <span className={CLS.connectorMeta}>
                    {connector.directions.map((direction) => (
                      <span key={direction} className={CLS.connectorDirection}>{direction}</span>
                    ))}
                  </span>
                  <span className={CLS.connectorState}>
                    {connector.enabled
                      ? <span className={CLS.connectorOn}>{t('connectorEnabled')}</span>
                      : <span className={CLS.connectorOff}>{t('connectorDisabled')}</span>}
                    {!connector.implemented && <span className={CLS.connectorOff}>{t('connectorPlaceholder')}</span>}
                  </span>
                  {connector.note !== undefined && <span className={CLS.connectorNote}>{connector.note}</span>}
                </li>
              ))}
            </ul>
            <p className={CLS.viewMeta}>{t('routingVersion', { version: state.routingVersion })}</p>
          </>
        )}
      <h3 className={CLS.viewSubheading}>
        {t('simTitle')}
        <span className={CLS.viewBadge}>{t('simDebug')}</span>
      </h3>
      <WorkbenchSimulator face={face} t={t} />
    </section>
  )
}

/**
 * Draw the apps view: the plugin panel directory and its three layouts.
 * @param props - the rows, the saved layout, and what the controls do.
 * @returns the toolbar and the chosen layout.
 */
export function AppsView(props: {
  readonly t: Translate
  readonly panels: readonly PanelRow[]
  readonly layout: ConsoleLayout
  readonly onOpen: (panel: PanelRow) => void
  readonly onTogglePin: (panel: PanelRow) => void
  readonly setLayout: (layout: ConsoleLayout) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const Layout = LAYOUTS[props.layout]
  const list: HomeListProps = {
    panels: filterPanels(props.panels, query),
    t: props.t,
    onOpen: props.onOpen,
    onTogglePin: props.onTogglePin,
    // Two different empties: nothing adopted, or nothing matching the search.
    emptyTitle: props.panels.length === 0 ? props.t('listEmpty') : props.t('searchEmpty'),
    emptyHint: props.panels.length === 0 ? props.t('listEmptyHint') : props.t('searchEmptyHint'),
  }
  return (
    <section className={CLS.view}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{props.t('viewApps')}</h2>
        <p className={CLS.viewHint}>{props.t('appsHint')}</p>
      </header>
      <div className={CLS.appsTools}>
        <Input
          className={CLS.search}
          type="search"
          icon={<IconSearchOutlineRegular />}
          value={query}
          placeholder={props.t('search')}
          aria-label={props.t('search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SegmentedControl
          id="dsh-console-layout"
          value={props.layout}
          label={props.t('layout')}
          options={LAYOUT_ORDER.map((name) => ({
            value: name,
            label: props.t(name === 'grid' ? 'layoutGrid' : name === 'list' ? 'layoutList' : 'layoutCompact'),
          }))}
          onChange={(next: ConsoleLayout) => props.setLayout(next)}
        />
      </div>
      <Layout {...list} />
    </section>
  )
}
