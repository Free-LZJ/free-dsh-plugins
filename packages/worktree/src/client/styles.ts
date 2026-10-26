/**
 * The plugin's one stylesheet: the management page, the dialog, and the
 * per-repository card material.
 *
 * A dynamically loaded browser half receives no stylesheet from the shell: the
 * Web client serves this package's `lib/client.js` and nothing else, so this half
 * carries its own copy and installs it once while the plugin is applied.
 *
 * The rules follow DSH's own style guide rather than inventing a look: every
 * colour is a `--dsw-alias-*` semantic token, cards use the settings-card
 * material and `--dsw-radius-xl`, neutral hairlines are `0.5px`, and each
 * `font-size` is paired with its line-height. The controls themselves are the
 * shared primitives — what is left here is layout.
 *
 * @module @free-lzj/dsh-worktree/client/styles
 */

/** Class names the installed stylesheet defines. */
export const CLS = {
  field: 'dshw-field',
  label: 'dshw-label',
  hint: 'dshw-hint',
  section: 'dshw-section',
  sectionTitle: 'dshw-section-title',
  list: 'dshw-list',
  row: 'dshw-row',
  rowText: 'dshw-row-text',
  rowTitle: 'dshw-row-title',
  rowMeta: 'dshw-row-meta',
  rowActions: 'dshw-row-actions',
  error: 'dshw-error',
  panel: 'dshw-panel',
  panelHeader: 'dshw-panel-header',
  panelTitle: 'dshw-panel-title',
  panelBody: 'dshw-panel-body',
  panelTools: 'dshw-panel-tools',
  card: 'dshw-card',
  cardHead: 'dshw-card-head',
  cardTitle: 'dshw-card-title',
  cardPath: 'dshw-card-path',
  cardTools: 'dshw-card-tools',
  cardFoot: 'dshw-card-foot',
  rows: 'dshw-rows',
  formRow: 'dshw-form-row',
  formLabel: 'dshw-form-label',
  formControl: 'dshw-form-control',
  tag: 'dshw-tag',
} as const

/** The style element's identity, so a second apply does not add a second copy. */
const STYLE_ELEMENT_ID = '@free-lzj/dsh-worktree/panel.css'

/** The stylesheet. */
const CSS = `
.${CLS.field}{display:flex;flex-direction:column;gap:6px}
.${CLS.label}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.hint}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.${CLS.error}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
.${CLS.section}{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.sectionTitle}{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.list}{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-height:280px;overflow-y:auto}
.${CLS.row}{display:flex;align-items:center;gap:8px;padding:8px 0}
.${CLS.row}+.${CLS.row}{border-top:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.rowText}{display:flex;flex:1;flex-direction:column;min-width:0}
.${CLS.rowTitle}{display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.rowMeta}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.rowActions}{display:flex;flex:none;align-items:center;gap:4px}
.${CLS.tag}{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}

.${CLS.panel}{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.${CLS.panelHeader}{box-sizing:border-box;flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:10px 20px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.${CLS.panelTitle}{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.panelTools}{display:flex;flex:none;align-items:center;gap:8px}
.${CLS.panelBody}{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding:16px 20px 32px}

.${CLS.card}{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.${CLS.cardHead}{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.${CLS.cardTitle}{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.cardPath}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.${CLS.cardTools}{display:flex;flex:none;align-items:center;gap:8px}
.${CLS.cardFoot}{display:flex;justify-content:flex-end;gap:8px}

.${CLS.rows}{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.${CLS.formRow}{display:grid;grid-template-columns:120px minmax(0,1fr);align-items:start;gap:12px}
.${CLS.formLabel}{padding-top:5px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.${CLS.formControl}{display:flex;flex-direction:column;gap:4px;min-width:0}
`

/**
 * Install the stylesheet once.
 * @returns the disposer that removes it (the browser half's unload).
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ELEMENT_ID)}]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = '@free-lzj/dsh-worktree'
  style.dataset.pluginCss = STYLE_ELEMENT_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
