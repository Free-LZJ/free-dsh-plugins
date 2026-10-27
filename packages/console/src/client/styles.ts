/**
 * The workbench's one stylesheet.
 *
 * A dynamically loaded browser half receives no stylesheet from the shell: the
 * Web client serves this package's `lib/client.js` and nothing else, so the
 * workbench carries its own copy and installs it once while the plugin is
 * applied.
 *
 * The rules follow DSH's own style guide (`docs/web-styling.zh.md` and
 * `docs/ui-radius.zh.md` in the harness repository) rather than inventing a
 * look:
 *
 * - every colour is a `--dsw-alias-*` semantic token, never a literal;
 * - radii come from the shared scale (R20 for a card, R12 for a row, R8 for a
 *   compact control) and neutral hairlines are `0.5px`;
 * - the header copies the conversation page's top bar (`10px 28px 10px 20px`,
 *   a 30px row, a `--dsw-alias-border-l3` rule) and the cards copy the
 *   settings-card material, so the workbench reads as another DSH surface;
 * - the controls themselves are the shared primitives; what is left here is
 *   layout and the two surfaces no primitive draws.
 *
 * @module @free-lzj/dsh-console/client/styles
 */

/** Class names the installed stylesheet defines. */
export const CLS = {
  root: 'dshc-root',
  header: 'dshc-header',
  title: 'dshc-title',
  tools: 'dshc-tools',
  search: 'dshc-search',
  body: 'dshc-body',
  cards: 'dshc-cards',
  list: 'dshc-list',
  compact: 'dshc-compact',
  card: 'dshc-card',
  cardOpen: 'dshc-card-open',
  cardMain: 'dshc-card-main',
  cardIcon: 'dshc-card-icon',
  cardTitle: 'dshc-card-title',
  cardDesc: 'dshc-card-desc',
  cardActions: 'dshc-card-actions',
  empty: 'dshc-empty',
  noticePanel: 'dshc-notice-panel',
  noticeList: 'dshc-notice-list',
  notice: 'dshc-notice',
  noticeTitle: 'dshc-notice-title',
  noticeBody: 'dshc-notice-body',
  noticeTime: 'dshc-notice-time',
  noticeFoot: 'dshc-notice-foot',
  openError: 'dshc-open-error',
  attention: 'dshc-attention',
  attentionHead: 'dshc-attention-head',
  attentionHeading: 'dshc-attention-heading',
  attentionSubheading: 'dshc-attention-subheading',
  attentionList: 'dshc-attention-list',
  attentionItem: 'dshc-attention-item',
  attentionMain: 'dshc-attention-main',
  attentionTitle: 'dshc-attention-title',
  attentionBody: 'dshc-attention-body',
  attentionMeta: 'dshc-attention-meta',
  attentionActions: 'dshc-attention-actions',
  running: 'dshc-running',
  runningLabel: 'dshc-running-label',
  runningList: 'dshc-running-list',
  runningItem: 'dshc-running-item',
  noticeActions: 'dshc-notice-actions',
  noticeFailure: 'dshc-notice-failure',
  noticeSuccess: 'dshc-notice-success',
  noticeWarn: 'dshc-notice-warn',
  noticeError: 'dshc-notice-error',
  row: 'dshc-row',
  rowText: 'dshc-row-text',
  rowTitle: 'dshc-row-title',
  rowDesc: 'dshc-row-desc',
  selector: 'dshc-selector',
  chevron: 'dshc-chevron',
  wbRoot: 'dshc-wb-root',
  wbTitle: 'dshc-wb-title',
  wbHint: 'dshc-wb-hint',
  wbColumns: 'dshc-wb-columns',
  wbColumn: 'dshc-wb-column',
  wbColumnTitle: 'dshc-wb-column-title',
  wbCards: 'dshc-wb-cards',
  wbCard: 'dshc-wb-card',
  wbCardTitle: 'dshc-wb-card-title',
  wbCardMeta: 'dshc-wb-card-meta',
  wbCardActions: 'dshc-wb-card-actions',
  wbSession: 'dshc-wb-session',
  wbSubtitle: 'dshc-wb-subtitle',
  wbEmpty: 'dshc-wb-empty',
  wbSessionList: 'dshc-wb-session-list',
  wbLogs: 'dshc-wb-logs',
  wbLog: 'dshc-wb-log',
  wbRow: 'dshc-wb-row',
  wbSim: 'dshc-wb-sim',
  wbAnswer: 'dshc-wb-answer',
  wbMeta: 'dshc-wb-meta',
  wbMetaList: 'dshc-wb-meta-list',
  wbMetaItem: 'dshc-wb-meta-item',
  wbMetaNote: 'dshc-wb-meta-note',
} as const

/** Id of the one style element the workbench installs, keyed so a reload replaces it. */
const STYLE_ELEMENT_ID = 'dsh-console-styles'

/** The stylesheet body. */
const CSS = `
.${CLS.root}{display:flex;flex-direction:column;height:100%;min-height:0}
.${CLS.header}{flex:none;box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:30px;padding:10px 28px 10px 20px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.${CLS.title}{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.tools}{margin-left:auto;display:flex;align-items:center;gap:8px}
.${CLS.search}{width:200px}
.${CLS.body}{flex:1;min-height:0;overflow-y:auto;padding:16px 28px 32px}
.${CLS.cards}{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:0;padding:0;list-style:none}
.${CLS.list}{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.${CLS.compact}{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:0;padding:0;list-style:none}
.${CLS.card}{position:relative;display:flex;flex-direction:column;width:100%;min-width:0;overflow:hidden;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.${CLS.cardOpen}{box-sizing:border-box;display:flex;flex:1 1 auto;flex-direction:column;align-items:stretch;gap:2px;width:100%;min-height:52px;padding:12px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.${CLS.cardOpen}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${CLS.cardOpen}:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.${CLS.compact} .${CLS.cardOpen}{min-height:0;padding:10px 12px}
.${CLS.cardMain}{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.${CLS.compact} .${CLS.cardMain}{gap:8px}
.${CLS.cardIcon}{display:inline-flex;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.${CLS.cardTitle}{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.cardDesc}{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.cardActions}{position:absolute;top:4px;right:4px;display:flex;align-items:center;opacity:0}
.${CLS.card}:hover .${CLS.cardActions},.${CLS.card}:focus-within .${CLS.cardActions}{opacity:1}
.${CLS.empty}{margin:0;padding:48px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
/* The notice popover is portaled, so it carries its own fixed frame and the
   same layer the shared menu list uses to clear modal overlays (z 1000). */
.${CLS.noticePanel}{position:fixed;top:auto;left:auto;z-index:1100}
.${CLS.noticeList}{display:flex;flex-direction:column;width:320px;max-height:360px;overflow-y:auto;padding:8px}
.${CLS.notice}{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:var(--dsw-radius-md)}
.${CLS.noticeTitle}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.noticeActions}{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.${CLS.openError}{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.${CLS.attention}{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-settings-card-stroke)}
.${CLS.attentionHead}{display:flex;align-items:center;justify-content:space-between;gap:8px}
.${CLS.attentionHeading}{margin:0;font-size:14px;line-height:22px}
.${CLS.attentionSubheading}{margin:4px 0 0;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.${CLS.attentionList}{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.${CLS.attentionItem}{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.attentionMain}{display:flex;flex-direction:column;gap:2px;min-width:0}
.${CLS.attentionTitle}{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.attentionBody}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.attentionMeta}{display:flex;align-items:center;gap:6px}
.${CLS.attentionActions}{display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.${CLS.running}{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${CLS.runningLabel}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.runningList}{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.${CLS.runningItem}{display:flex;flex-direction:column}
.${CLS.noticeFailure}{margin:0 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.noticeBody}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.${CLS.noticeTime}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.noticeSuccess} .${CLS.noticeTitle}{color:var(--dsw-alias-state-success-primary)}
.${CLS.noticeWarn} .${CLS.noticeTitle}{color:var(--dsw-alias-state-warn-primary)}
.${CLS.noticeError} .${CLS.noticeTitle}{color:var(--dsw-alias-state-error-primary)}
.${CLS.noticeFoot}{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:6px 8px 0;margin-top:6px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.row}{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.rowText}{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0;padding-right:48px}
.${CLS.rowTitle}{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.${CLS.rowDesc}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.selector}{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
.${CLS.selector}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${CLS.chevron}{flex:none}
/* The board: three columns over the home list, then the session focus, the
   simulator, and the meta lists. Same materials as the home cards, so the
   board reads as another workbench surface rather than a second product. */
.${CLS.wbRoot}{display:flex;flex-direction:column;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.${CLS.wbTitle}{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.wbHint}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.wbColumns}{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.${CLS.wbColumn}{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}
.${CLS.wbColumnTitle}{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.wbCards}{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.${CLS.wbCard}{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.${CLS.wbCardTitle}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.wbCardMeta}{display:flex;flex-wrap:wrap;gap:4px}
.${CLS.wbCardActions}{display:flex;gap:6px}
.${CLS.wbSession}{display:flex;flex-direction:column;gap:8px}
.${CLS.wbSubtitle}{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.wbEmpty}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.wbSessionList}{display:flex;flex-wrap:wrap;gap:6px}
.${CLS.wbLogs}{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;margin:0;padding:8px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);list-style:none}
.${CLS.wbLog}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.${CLS.wbRow}{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${CLS.wbSim}{display:flex;flex-direction:column;gap:8px}
.${CLS.wbAnswer}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.wbMeta}{display:flex;flex-direction:column;gap:8px}
.${CLS.wbMetaList}{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.${CLS.wbMetaItem}{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.wbMetaNote}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
`

/**
 * Install the stylesheet once.
 * @returns the disposer that removes it (the browser half's unload).
 */
export function installConsoleStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ELEMENT_ID)}]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = '@free-lzj/dsh-console'
  style.dataset.pluginCss = STYLE_ELEMENT_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
