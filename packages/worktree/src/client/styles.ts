/**
 * The two rules the worktree dialog needs beyond the shared primitives.
 *
 * A dynamically loaded browser half receives no stylesheet from the shell: the
 * Web client serves this package's `lib/client.js` and nothing else, so the
 * dialog carries its own copy and installs it once while the plugin is applied.
 * Colours are `--dsw-alias-*` tokens, the field row keeps DSH's 14/22 type pair,
 * and the trigger itself is the shared `Button` — nothing here re-draws a
 * control the design system already owns.
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
} as const

/** The style element's identity, so a second apply does not add a second copy. */
const STYLE_ELEMENT_ID = '@free-lzj/dsh-worktree/dialog.css'

/** The stylesheet. */
const CSS = `
.${CLS.field}{display:flex;flex-direction:column;gap:6px}
.${CLS.label}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.hint}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.${CLS.section}{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.sectionTitle}{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.list}{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-height:280px;overflow-y:auto}
.${CLS.row}{display:flex;align-items:center;gap:8px;padding:6px 0;border-radius:var(--dsw-radius-sm)}
.${CLS.rowText}{display:flex;flex:1;flex-direction:column;min-width:0}
.${CLS.rowTitle}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.rowMeta}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.rowActions}{display:flex;flex:none;align-items:center;gap:4px}
.${CLS.error}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
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
