/**
 * The route paths this plugin owns.
 *
 * They live in their own module because both `index.ts` (which mounts them) and
 * `routes.ts` (which declares them) need them: importing them from `index.ts`
 * would make the two modules import each other.
 *
 * @module @free-lzj/dsh-mail/paths
 */

/** Root of every path this plugin serves. */
export const ROUTE_PREFIX = '/dsh-mail'

/** Route the panel document itself is served on. */
export const PANEL_PATH = `${ROUTE_PREFIX}/panel`

/** Route the panel reads inbox state from. */
export const STATE_PATH = `${ROUTE_PREFIX}/state`

/** Route the panel reads one message body from. */
export const MESSAGE_PATH = `${ROUTE_PREFIX}/message`

/** Route the panel downloads one attachment from. */
export const ATTACHMENT_PATH = `${ROUTE_PREFIX}/attachment`

/** Route the panel changes message state through. */
export const ACTION_PATH = `${ROUTE_PREFIX}/action`

/** Route the panel reads and writes accounts and trigger settings through. */
export const CONFIG_PATH = `${ROUTE_PREFIX}/config`

/** Route the panel asks for an immediate scan through. */
export const REFRESH_PATH = `${ROUTE_PREFIX}/refresh`

/** Route the panel asks for one older page of mail through. */
export const MORE_PATH = `${ROUTE_PREFIX}/more`

/**
 * Root of the triage routes.
 *
 * Under this plugin's own prefix rather than a second one: triage is part of
 * mail now, and a second prefix would be a second surface to keep
 * same-origin-safe.
 */
export const TRIAGE_PREFIX = `${ROUTE_PREFIX}/triage`

/** Route the panel reads the rule list and its source state from. */
export const TRIAGE_RULES_PATH = `${TRIAGE_PREFIX}/rules`

/** Route the panel switches one rule on or off through. */
export const TRIAGE_RULE_ENABLED_PATH = `${TRIAGE_PREFIX}/rules/enabled`

/** Route the panel changes one action's three-state mode through. */
export const TRIAGE_RULE_MODE_PATH = `${TRIAGE_PREFIX}/rules/mode`
export const TRIAGE_RULE_CONDITION_PATH = `${TRIAGE_PREFIX}/rules/condition`

/** Route the panel moves one rule up or down through. */
export const TRIAGE_RULE_PRIORITY_PATH = `${TRIAGE_PREFIX}/rules/priority`

/** Route the panel reads the run history from. */
export const TRIAGE_RUNS_PATH = `${TRIAGE_PREFIX}/runs`

/** Route the panel undoes one run through. */
export const TRIAGE_UNDO_PATH = `${TRIAGE_PREFIX}/undo`

/** Route the panel tries the rules against one already-received message. */
export const TRIAGE_TEST_PATH = `${TRIAGE_PREFIX}/test`
