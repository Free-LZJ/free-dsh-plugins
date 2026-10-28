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

/** Change one action's three-state mode. */
export const RULES_MODE_PATH = `${RULES_PREFIX}/mode`

/** Replace one condition's match values. */
export const RULES_CONDITION_PATH = `${RULES_PREFIX}/condition`

/** Move one rule up or down. */
export const RULES_PRIORITY_PATH = `${RULES_PREFIX}/priority`

/** Undo one hit record. */
export const RULES_UNDO_PATH = `${RULES_PREFIX}/undo`

/** Run the current rules against one event without touching it. */
export const RULES_TEST_PATH = `${RULES_PREFIX}/test`
