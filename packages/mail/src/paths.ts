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

