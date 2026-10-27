/**
 * Two of the content views the workbench shows beside the board: 连接器 and 应用.
 *
 * **连接器** is real capability that already exists: the connector metadata the
 * board advertises, plus the event simulator, which is marked as a debug tool
 * rather than a product feature. **应用** is the old home page's reason for
 * existing, demoted from the whole workbench body to one view: the panel
 * directory, with its three layouts and its search.
 *
 * 规则 has its own module (`./rules.tsx`) because it talks to another plugin.
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
