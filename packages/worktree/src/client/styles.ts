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
} as const

/** The style element's identity, so a second apply does not add a second copy. */
const STYLE_ELEMENT_ID = '@free-lzj/dsh-worktree/dialog.css'

/** The stylesheet. */
const CSS = `
.${CLS.field}{display:flex;flex-direction:column;gap:6px}
.${CLS.label}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.hint}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
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
