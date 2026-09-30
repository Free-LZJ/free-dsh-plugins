/**
 * The agent-import card's stylesheet.
 *
 * A dynamically loaded browser half receives no stylesheet from the shell: the
 * Web client serves this package's `lib/client.js` and nothing else, so the
 * card carries its own copy and installs it once while the plugin is applied.
 * The rules reference only the shared `--dsw-*` design tokens, so the card
 * follows the active theme like a statically linked feature does.
 */

/** Class names the installed stylesheet defines, for the card to reference. */
export const AGENT_IMPORT_CLASS = {
  section: 'dsh-agent-import-section',
  heading: 'dsh-agent-import-heading',
  hint: 'dsh-agent-import-hint',
  choices: 'dsh-agent-import-choices',
  choice: 'dsh-agent-import-choice',
  field: 'dsh-agent-import-field',
  toggles: 'dsh-agent-import-toggles',
  toggle: 'dsh-agent-import-toggle',
  toggleText: 'dsh-agent-import-toggle-text',
  toggleLabel: 'dsh-agent-import-toggle-label',
  override: 'dsh-agent-import-override',
  list: 'dsh-agent-import-list',
  listRow: 'dsh-agent-import-list-row',
  actions: 'dsh-agent-import-actions',
  summary: 'dsh-agent-import-summary',
  summaryText: 'dsh-agent-import-summary-text',
  subheading: 'dsh-agent-import-subheading',
  tableWrap: 'dsh-agent-import-table-wrap',
  table: 'dsh-agent-import-table',
  columnName: 'dsh-agent-import-column-name',
  columnSource: 'dsh-agent-import-column-source',
  columnStatus: 'dsh-agent-import-column-status',
  columnReason: 'dsh-agent-import-column-reason',
  cellName: 'dsh-agent-import-cell-name',
  cellClip: 'dsh-agent-import-cell-clip',
  cellCode: 'dsh-agent-import-cell-code',
  cellAside: 'dsh-agent-import-cell-aside',
  cellReason: 'dsh-agent-import-cell-reason',
  tabs: 'dsh-agent-import-tabs',
  panel: 'dsh-agent-import-panel',
  itemNotes: 'dsh-agent-import-item-notes',
} as const

/** Id of the one style element the card installs, keyed so a reload replaces it. */
const STYLE_ELEMENT_ID = 'dsh-agent-import-card-styles'

/** The card's rules, in the order the card renders. */
const AGENT_IMPORT_CSS = `
.${AGENT_IMPORT_CLASS.section} {
  min-width: 0;
  padding: 18px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.${AGENT_IMPORT_CLASS.section}:first-child {
  padding-top: 0;
  border-top: 0;
}
.${AGENT_IMPORT_CLASS.heading} {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${AGENT_IMPORT_CLASS.hint} {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}
.${AGENT_IMPORT_CLASS.choices} {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  margin-top: 10px;
}
.${AGENT_IMPORT_CLASS.field} {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.${AGENT_IMPORT_CLASS.toggles} {
  display: grid;
  gap: 14px;
  margin-top: 10px;
}
.${AGENT_IMPORT_CLASS.toggle} {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
}
.${AGENT_IMPORT_CLASS.toggleText} {
  min-width: 0;
}
.${AGENT_IMPORT_CLASS.toggleLabel} {
  display: block;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${AGENT_IMPORT_CLASS.toggle} .${AGENT_IMPORT_CLASS.hint} {
  margin-top: 2px;
}
.${AGENT_IMPORT_CLASS.override} {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.${AGENT_IMPORT_CLASS.list} {
  display: grid;
  gap: 8px;
  margin: 10px 0;
}
.${AGENT_IMPORT_CLASS.listRow} {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.${AGENT_IMPORT_CLASS.actions} {
  display: flex;
  margin-top: 10px;
}
.${AGENT_IMPORT_CLASS.summary} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.${AGENT_IMPORT_CLASS.summaryText} {
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.${AGENT_IMPORT_CLASS.subheading} {
  margin: 14px 0 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${AGENT_IMPORT_CLASS.tableWrap} {
  margin-top: 8px;
  overflow-x: auto;
}
.${AGENT_IMPORT_CLASS.tabs} {
  margin-bottom: 14px;
}
.${AGENT_IMPORT_CLASS.panel} {
  min-width: 0;
}
.${AGENT_IMPORT_CLASS.table} {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
  line-height: 1.5;
}
.${AGENT_IMPORT_CLASS.table} th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: var(--dsw-alias-label-tertiary);
}
.${AGENT_IMPORT_CLASS.table} td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.${AGENT_IMPORT_CLASS.table} tbody tr:last-child td {
  border-bottom: 0;
}
.${AGENT_IMPORT_CLASS.table} tbody tr:hover td {
  background: var(--dsw-alias-interactive-bg-hover);
}
.${AGENT_IMPORT_CLASS.columnName} {
  width: 38%;
}
.${AGENT_IMPORT_CLASS.columnSource} {
  width: 104px;
}
.${AGENT_IMPORT_CLASS.columnStatus} {
  width: 92px;
}
.${AGENT_IMPORT_CLASS.columnReason} {
  width: 30%;
}
.${AGENT_IMPORT_CLASS.cellName} {
  font-weight: 500;
}
.${AGENT_IMPORT_CLASS.cellClip} {
  min-width: 0;
}
.${AGENT_IMPORT_CLASS.cellCode} {
  font-family: var(--dsw-font-markdown-code-font-family, Consolas, monospace);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.${AGENT_IMPORT_CLASS.cellAside} {
  margin-left: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.${AGENT_IMPORT_CLASS.cellReason} {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.${AGENT_IMPORT_CLASS.itemNotes} {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}
`

/**
 * Install the card's stylesheet, replacing any copy a previous load left behind.
 * @returns the disposer that removes the element this call installed.
 */
export function installAgentImportStyles(): () => void {
  const target = globalThis.document
  if (target === undefined) return () => {}
  let element = target.getElementById(STYLE_ELEMENT_ID)
  if (element === null) {
    element = target.createElement('style')
    element.id = STYLE_ELEMENT_ID
    target.head.append(element)
  }
  element.textContent = AGENT_IMPORT_CSS
  return () => {
    if (element.isConnected) element.remove()
  }
}
