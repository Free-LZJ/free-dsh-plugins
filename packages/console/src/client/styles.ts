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
 * - radii come only from the shared scale (R8 compact control, R12 row, R16
 *   multi-line cell, R20 card, R28 panel) and neutral hairlines are `0.5px`;
 * - the header copies the conversation page's top bar and the view navigation
 *   copies its tab strip (`gap: 36px`, 13/16, business-primary plus a 2px bar),
 *   so the workbench reads as another DSH surface rather than a second product;
 * - font sizes always travel with their line height (14/22, 13/20, 12/18, 11/16);
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
  nav: 'dshc-nav',
  navItem: 'dshc-nav-item',
  navItemActive: 'dshc-nav-item-active',
  body: 'dshc-body',
  view: 'dshc-view',
  viewHead: 'dshc-view-head',
  viewHeading: 'dshc-view-heading',
  viewHint: 'dshc-view-hint',
  viewMeta: 'dshc-view-meta',
  viewSubheading: 'dshc-view-subheading',
  appsTools: 'dshc-apps-tools',
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
  attentionFailure: 'dshc-attention-failure',
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
  board: 'dshc-board',
  boardHint: 'dshc-board-hint',
  boardFailure: 'dshc-board-failure',
  statusBar: 'dshc-status-bar',
  stat: 'dshc-stat',
  statValue: 'dshc-stat-value',
  statLabel: 'dshc-stat-label',
  boardColumns: 'dshc-board-columns',
  column: 'dshc-column',
  columnOver: 'dshc-column-over',
  columnHead: 'dshc-column-head',
  columnTitleRow: 'dshc-column-title-row',
  columnTitle: 'dshc-column-title',
  columnCount: 'dshc-column-count',
  columnHint: 'dshc-column-hint',
  columnEmpty: 'dshc-column-empty',
  cardsList: 'dshc-cards-list',
  dayGroups: 'dshc-day-groups',
  dayGroup: 'dshc-day-group',
  boardCard: 'dshc-board-card',
  boardCardTitle: 'dshc-board-card-title',
  boardCardBody: 'dshc-board-card-body',
  cardFrom: 'dshc-card-from',
  cardRef: 'dshc-card-ref',
  cardPriority: 'dshc-card-priority',
  cardFacts: 'dshc-card-facts',
  cardNote: 'dshc-card-note',
  cardFoot: 'dshc-card-foot',
  cardExecutor: 'dshc-card-executor',
  cardStatus: 'dshc-card-status',
  cardWhen: 'dshc-card-when',
  cardBar: 'dshc-card-bar',
  detailHeading: 'dshc-detail-heading',
  detailList: 'dshc-detail-list',
  detailReasons: 'dshc-detail-reasons',
  detailReason: 'dshc-detail-reason',
  detailNote: 'dshc-detail-note',
  detailChainFoot: 'dshc-detail-chain-foot',
  cardDetailDialog: 'dshc-card-detail-dialog',
  cardDetailScroll: 'dshc-card-detail-scroll',
  cardDetailColumns: 'dshc-card-detail-columns',
  cardDetailSide: 'dshc-card-detail-side',
  cardDetailMain: 'dshc-card-detail-main',
  cardDetailFooterStart: 'dshc-card-detail-footer-start',
  steps: 'dshc-steps',
  step: 'dshc-step',
  stepIndex: 'dshc-step-index',
  stepBody: 'dshc-step-body',
  stepTitle: 'dshc-step-title',
  stepMeta: 'dshc-step-meta',
  stepWhen: 'dshc-step-when',
  stepTail: 'dshc-step-tail',
  stepNotice: 'dshc-step-notice',
  sessionBox: 'dshc-session-box',
  sessionLogTitle: 'dshc-session-log-title',
  sessionLog: 'dshc-session-log',
  logLine: 'dshc-log-line',
  ruleNotice: 'dshc-rule-notice',
  testBox: 'dshc-test-box',
  testVerdict: 'dshc-test-verdict',
  ruleRawBlock: 'dshc-rule-raw-block',
  ruleRawTitle: 'dshc-rule-raw-title',
  ruleRaw: 'dshc-rule-raw',
  ruleDropped: 'dshc-rule-dropped',
  ruleList: 'dshc-rule-list',
  ruleItem: 'dshc-rule-item',
  ruleHead: 'dshc-rule-head',
  ruleOrder: 'dshc-rule-order',
  ruleName: 'dshc-rule-name',
  ruleTools: 'dshc-rule-tools',
  ruleWhen: 'dshc-rule-when',
  ruleThen: 'dshc-rule-then',
  ruleWhenLabel: 'dshc-rule-when-label',
  ruleWhenValue: 'dshc-rule-when-value',
  ruleWhenValueButton: 'dshc-rule-when-value-button',
  ruleValueInput: 'dshc-rule-value-input',
  ruleCondition: 'dshc-rule-condition',
  ruleAction: 'dshc-rule-action',
  runList: 'dshc-run-list',
  runItem: 'dshc-run-item',
  runHead: 'dshc-run-head',
  runWhen: 'dshc-run-when',
  runRule: 'dshc-run-rule',
  runSubject: 'dshc-run-subject',
  runTail: 'dshc-run-tail',
  runActions: 'dshc-run-actions',
  runAction: 'dshc-run-action',
  focus: 'dshc-focus',
  focusList: 'dshc-focus-list',
  focusItem: 'dshc-focus-item',
  focusMain: 'dshc-focus-main',
  focusTitle: 'dshc-focus-title',
  focusMeta: 'dshc-focus-meta',
  focusState: 'dshc-focus-state',
  connectorList: 'dshc-connector-list',
  connectorItem: 'dshc-connector-item',
  connectorName: 'dshc-connector-name',
  connectorMeta: 'dshc-connector-meta',
  connectorDirection: 'dshc-connector-direction',
  connectorState: 'dshc-connector-state',
  connectorOn: 'dshc-connector-on',
  connectorOff: 'dshc-connector-off',
  connectorNote: 'dshc-connector-note',
} as const

/** Id of the one style element the workbench installs, keyed so a reload replaces it. */
const STYLE_ELEMENT_ID = 'dsh-console-styles'

/** The stylesheet body. */
const CSS = `
.${CLS.root}{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.${CLS.header}{flex:none;box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:30px;padding:10px 28px 10px 20px}
.${CLS.title}{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.tools}{margin-left:auto;display:flex;align-items:center;gap:8px}
.${CLS.search}{width:200px}
/* Conversation tabs, copied: 35px strip above the rule, 13/16 at weight 500,
   business-primary plus a 2px bar for the current one. The tab's own padding
   puts its bottom edge on the rule so the bar covers it. */
.${CLS.nav}{flex:none;display:flex;gap:36px;margin-top:10px;padding:0 28px 0 20px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.${CLS.nav} .${CLS.navItem}{height:auto;min-height:0;padding:0 0 9px;border-radius:0;background:transparent;font-size:13px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);position:relative}
.${CLS.nav} .${CLS.navItem}:hover:not(:disabled){background:transparent;color:var(--dsw-alias-label-secondary)}
.${CLS.nav} .${CLS.navItem}:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.${CLS.nav} .${CLS.navItemActive},.${CLS.nav} .${CLS.navItemActive}:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}
.${CLS.nav} .${CLS.navItemActive}::after{content:'';position:absolute;right:0;left:0;bottom:-1px;height:2px;background:var(--dsw-alias-state-business-primary)}
.${CLS.body}{display:flex;flex:1;flex-direction:column;gap:16px;min-height:0;overflow-y:auto;padding:16px 28px 32px 20px}
.${CLS.body}>*{width:100%;max-width:1440px;margin-right:auto;margin-left:auto}
.${CLS.view}{display:flex;flex-direction:column;gap:10px}
.${CLS.viewHead}{display:flex;flex-direction:column;gap:2px}
.${CLS.viewHeading}{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.viewHint}{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.viewMeta}{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.viewSubheading}{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.appsTools}{display:flex;align-items:center;gap:8px;margin-bottom:4px}
/* The board: a summary strip, then three columns of cards. The strip is a line of
   figures, not four controls — it carries no fill so it reads as a summary. */
.${CLS.board}{display:flex;flex:1;flex-direction:column;gap:12px;min-height:0}
.${CLS.statusBar}{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:4px 24px}
.${CLS.stat}{display:flex;align-items:center;gap:6px}
.${CLS.statValue}{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.statLabel}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.boardHint}{margin:0;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.boardFailure}{margin:0;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.${CLS.boardColumns}{display:grid;flex:1;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:stretch;min-height:0}
.${CLS.column}{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;overflow:hidden;padding:10px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}
.${CLS.columnOver}{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.${CLS.columnHead}{display:flex;flex:none;flex-direction:column;gap:2px}
.${CLS.columnTitleRow}{display:flex;align-items:center;gap:6px}
.${CLS.columnTitle}{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.columnCount}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.columnHint}{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.columnEmpty}{margin:0;padding:16px 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.cardsList}{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;margin:0;padding:0;list-style:none}
.${CLS.dayGroups}{display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0}
.${CLS.dayGroup}{display:flex;flex:none;flex-direction:column;gap:6px}
.${CLS.boardCard}{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);cursor:grab}
.${CLS.boardCard}:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.${CLS.cardFrom}{display:flex;align-items:center;gap:6px;min-width:0}
.${CLS.cardRef}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.cardPriority}{margin-left:auto;display:inline-flex;flex:none}
.${CLS.boardCardTitle}{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.boardCardBody}{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.cardFacts}{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.${CLS.cardNote}{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.${CLS.cardFoot}{display:flex;align-items:center;gap:6px;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${CLS.cardExecutor}{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS.cardStatus}{flex:none;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.cardWhen}{margin-left:auto;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* The action bar is always laid out and always visible: hiding it left a blank
   strip the height of a button inside every card, and "there is something you can
   do here" is worth more than the quiet. Keyboard focus still lights the card up. */
.${CLS.cardBar}{display:flex;flex-wrap:wrap;gap:6px}
.${CLS.detailHeading}{margin:12px 0 4px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.detailList}{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
.${CLS.detailList} dt{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${CLS.detailList} dd{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.${CLS.detailReasons}{display:flex;flex-direction:column;gap:2px;margin:0;padding:0 0 0 16px}
.${CLS.detailReason}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.detailNote}{margin:4px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* 详情是产品页，不是确认框：Modal 的默认 380px 只够确认用，链路与会话放不下。
   宽度与高度都相对 Modal 的 padding box 定（不写 vh —— 主面板比 100vh 矮一个标题栏）。
   类名重复一次是为了把特异性抬到 CSS Module 之上：插件样式表与模块样式的注入顺序
   不可依赖，同优先级会看运气。 */
.${CLS.cardDetailDialog}.${CLS.cardDetailDialog}{width:min(960px,100%);max-height:100%}
.${CLS.cardDetailDialog} .${CLS.cardDetailScroll}{overflow-y:auto;min-height:0;flex:1 1 auto}
.${CLS.cardDetailColumns}{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:24px;align-items:start}
.${CLS.cardDetailSide},.${CLS.cardDetailMain}{display:flex;min-width:0;flex-direction:column}
.${CLS.cardDetailFooterStart}{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-right:auto}
.${CLS.detailChainFoot}{display:flex;align-items:flex-start;gap:12px;margin-top:8px}
.${CLS.detailChainFoot} .${CLS.detailNote}{flex:1;margin:0}
@media (max-width:760px){
  .${CLS.cardDetailColumns}{grid-template-columns:minmax(0,1fr)}
}
/* 链路详情：一条竖列，步骤按发生顺序依次点亮（animation-delay 由行内样式给）。
   动画只是把顺序走一遍——播完就是一列静态可读的字，reduced-motion 下直接不播。 */
@keyframes dshc-step-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.${CLS.steps}{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.${CLS.step}{display:grid;grid-template-columns:18px minmax(0,1fr) max-content;align-items:start;gap:8px;animation:dshc-step-in .3s ease-out both}
.${CLS.stepNotice}{opacity:.9}
.${CLS.stepIndex}{display:inline-flex;flex:none;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.stepBody}{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
.${CLS.stepTitle}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.${CLS.stepMeta}{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.stepWhen}{font-size:11px;line-height:24px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.${CLS.stepTail}{display:inline-flex;align-items:center;justify-content:flex-end;gap:6px}
@media (prefers-reduced-motion:reduce){
  .${CLS.step}{animation:none}
}
.${CLS.sessionBox}{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${CLS.sessionLogTitle}{margin:0;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.${CLS.sessionLog}{display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;margin:0;padding:0;list-style:none}
.${CLS.logLine}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
/* 规则视图：一条规则一张卡（Rule → conditions → actions），命中记录各自一条。 */
.${CLS.ruleNotice}{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.${CLS.testBox}{display:flex;flex-direction:column;gap:2px;margin-top:4px;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-settings-card-stroke)}
.${CLS.testVerdict}{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary)}
.${CLS.ruleRawBlock}{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:6px 10px}
.${CLS.ruleRawTitle}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.${CLS.ruleRaw}{margin:6px 0 0;max-height:260px;overflow:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.${CLS.ruleDropped}{margin:0;padding:0 0 0 16px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.${CLS.ruleList}{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.${CLS.ruleItem}{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.${CLS.ruleHead}{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${CLS.ruleOrder}{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${CLS.ruleName}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.ruleTools}{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
.${CLS.ruleWhen},.${CLS.ruleThen}{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;line-height:18px}
.${CLS.ruleWhenLabel}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.ruleWhenValue}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.${CLS.ruleWhenValueButton}{height:auto;min-height:0;max-width:100%;padding:0 2px;border:0;border-bottom:1px dashed var(--dsw-alias-border-l4);border-radius:0;background:transparent;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}
.${CLS.ruleWhenValueButton}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${CLS.ruleWhenValueButton}:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.${CLS.ruleValueInput}{display:flex;flex:1 1 240px;width:100%;min-width:0}
.${CLS.ruleCondition},.${CLS.ruleAction}{display:inline-flex;align-items:center;gap:4px}
/* 编辑时就地占一整行：长值列表不该挤在条件标签旁边只剩一个输入框的宽度。 */
.${CLS.ruleCondition}:has(> .${CLS.ruleValueInput}){flex:1 1 100%}
.${CLS.ruleValueInput}{flex:1 1 100%;width:100%}
.${CLS.runList}{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.${CLS.runItem}{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${CLS.runHead}{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${CLS.runWhen}{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.runRule}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.${CLS.runSubject}{flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${CLS.runTail}{display:inline-flex;align-items:center;gap:6px;margin-left:auto}
.${CLS.runActions}{display:flex;flex-direction:column;gap:2px;margin:0;padding:0 0 0 4px;list-style:none}
.${CLS.runAction}{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${CLS.focus}{display:flex;flex-direction:column;gap:10px}
.${CLS.focusList}{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.${CLS.focusItem}{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill)}
.${CLS.focusMain}{display:flex;flex-direction:column;gap:2px;min-width:0}
.${CLS.focusTitle}{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.focusMeta}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.${CLS.focusState}{display:inline-flex;align-items:center;gap:6px;flex:none}
.${CLS.connectorList}{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.${CLS.connectorItem}{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill)}
.${CLS.connectorName}{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${CLS.connectorMeta}{display:inline-flex;gap:4px}
.${CLS.connectorDirection}{padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${CLS.connectorState}{display:inline-flex;gap:6px;margin-left:auto;font-size:11px;line-height:16px}
.${CLS.connectorOn}{color:var(--dsw-alias-state-success-primary)}
.${CLS.connectorOff}{color:var(--dsw-alias-label-tertiary)}
.${CLS.connectorNote}{flex-basis:100%;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
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
.${CLS.empty}{margin:0;padding:16px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
/* The notice popover is portaled, so it carries its own fixed frame and the
   same layer the shared menu list uses to clear modal overlays (z 1000). */
.${CLS.noticePanel}{position:fixed;top:auto;left:auto;z-index:1100}
.${CLS.noticeList}{display:flex;flex-direction:column;width:320px;max-height:360px;overflow-y:auto;padding:8px}
.${CLS.notice}{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:var(--dsw-radius-md)}
.${CLS.noticeTitle}{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.${CLS.noticeActions}{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.${CLS.openError}{margin:0 0 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
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
.${CLS.attentionFailure}{flex-basis:100%;margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
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
/* Narrow panels: the three columns become one scrolling stack. A 2560px window
   still reads as a page because the body caps its content width above. */
@media (max-width:1080px){
  .${CLS.boardColumns}{grid-template-columns:minmax(0,1fr);overflow-y:auto}
  .${CLS.column}{overflow:visible}
  .${CLS.cardsList},.${CLS.dayGroups}{overflow:visible}
}
@media (max-width:720px){
  .${CLS.header}{padding:8px 16px}
  .${CLS.nav}{gap:20px;padding:0 16px}
  .${CLS.body}{padding:12px 16px 24px}
}
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
