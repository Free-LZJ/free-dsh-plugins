/**
 * Every pathname this package serves.
 *
 * They live in their own module because both `index.ts` (which mounts them) and
 * `routes.ts` (which declares them) need them and neither may import the other.
 *
 * @module @free-lzj/dsh-console/paths
 */

/** Root of every path this plugin serves. */
export const ROUTE_PREFIX = '/dsh-console'

/** The workbench's full state: panel directory, notices, channel availability. */
export const STATE_PATH = `${ROUTE_PREFIX}/state`

/** Saved view preferences the browser writes back. */
export const CONFIG_PATH = `${ROUTE_PREFIX}/config`

/**
 * What the user did with one item: pick an action, dismiss it, or snooze it.
 *
 * Separate from {@link CONFIG_PATH} because it is a different kind of write: the
 * config route edits this plugin's own preferences, while this one is routed back to
 * whichever plugin raised the item.
 */
export const ITEM_PATH = `${ROUTE_PREFIX}/item`

/** The event stream (SSE) every open workbench tails: notices and directory changes. */
export const EVENTS_PATH = `${ROUTE_PREFIX}/events`

/** The board's full state: cards, sessions, connectors, routing version. */
export const WORKBENCH_STATE_PATH = `${ROUTE_PREFIX}/workbench/state`

/** The board's inbound event entrance: connectors and the event simulator post here. */
export const WORKBENCH_INGEST_PATH = `${ROUTE_PREFIX}/workbench/ingest`

/** The board's actions: dispatch, move, interrupt, pause, resume, end. */
export const WORKBENCH_ACTION_PATH = `${ROUTE_PREFIX}/workbench/action`

/**
 * Root of the rule engine's surface.
 *
 * The engine (and the rule file it owns) belongs to the workbench; a plugin that
 * feeds it is a connector and registers through `ctx.console.decision`, not
 * through a route of its own.
 */
export const RULES_PREFIX = `${ROUTE_PREFIX}/rules`

/** The rule file as the engine sees it: rules, source, parse error, raw text. */
export const RULES_STATE_PATH = `${RULES_PREFIX}/state`

/** The hit records, newest first. */
export const RULES_RUNS_PATH = `${RULES_PREFIX}/runs`

/** Switch one rule on or off. */
export const RULES_ENABLE_PATH = `${RULES_PREFIX}/enable`

/** Replace one condition's match values. */
export const RULES_CONDITION_PATH = `${RULES_PREFIX}/condition`

/** Move one rule up or down. */
export const RULES_PRIORITY_PATH = `${RULES_PREFIX}/priority`

/** Undo one hit record. */
export const RULES_UNDO_PATH = `${RULES_PREFIX}/undo`

/**
 * 记下「这条命中记录我看到了」。
 *
 * 与 `/undo` 分开：撤销是**试着把发生过的事倒回去**，这条只是让人把一条他决定不处理的
 * 记录从待办里拿走——两者失败的后果完全不同，路由不该共用一个。
 */
export const RULES_ACK_PATH = `${RULES_PREFIX}/ack`

/** Run the current rules against one event without touching it. */
export const RULES_TEST_PATH = `${RULES_PREFIX}/test`

/**
 * 节点图：带坐标的 nodes/edges，画布直接渲染。
 *
 * 与 {@link RULES_STATE_PATH} 分开：那份是「规则列表」的视角，这份是「图」的视角。
 * 同一份文件，两种读法——迁移期两者都得在，画布才不会因为文件是 v1 就打不开。
 */
export const RULES_FLOW_PATH = `${RULES_PREFIX}/flow`

/** 改图上一个节点（配置 / 坐标 / 名字 / 启用）。只写这一处，不整图覆盖。 */
export const RULES_FLOW_SAVE_PATH = `${RULES_PREFIX}/flow/save`


/** 重新自动布局一张图：换方向、换策略，位置写回文件。 */
export const RULES_FLOW_LAYOUT_PATH = `${RULES_PREFIX}/flow/layout`
/** 增删图上的节点。插入时新节点接管前一步的出路，删时把入边接到出边。 */
export const RULES_FLOW_NODE_PATH = `${RULES_PREFIX}/flow/node`

/** 已注册的节点类型：能放什么、每种要填什么。属性面板据此生成表单。 */
export const RULES_NODE_TYPES_PATH = `${RULES_PREFIX}/node-types`
