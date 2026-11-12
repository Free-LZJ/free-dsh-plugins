/**
 * Shapes and routes both halves agree on.
 *
 * The browser half never imports the Host half's runtime values — only these
 * types and the small amount of shared protocol they carry — so this module must
 * stay free of `node:*` imports and of anything that only exists on one side.
 *
 * @module @free-lzj/dsh-browser-use/protocol
 */

/** Where the browser half asks for mention candidates. */
export const MENTIONS_PATH = '/dsh-browser-use/mentions'

/**
 * One offerable thing, independent of what kind of thing it is.
 *
 * `ref` is `<provider>:<local id>`; the part after the colon belongs to that
 * provider alone, so the Host can resolve it without a second lookup table and
 * the browser half can hand it back verbatim.
 */
export interface MentionItem {
  readonly ref: string
  readonly label: string
  readonly description?: string
}

/** Candidates of one provider, rendered as one menu section. */
export interface MentionGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly MentionItem[]
}

/** One answer to a candidate request: every reachable group, in menu order. */
export interface MentionsResult {
  readonly groups: readonly MentionGroup[]
  /**
   * Providers that could not answer, as `id: message`.
   *
   * Returned rather than only logged: an empty menu has to be able to say why,
   * and the caller is often the only place a person can see it.
   */
  readonly failures?: readonly string[]
}

/** Refusal shape every route uses instead of a bare status. */
export interface FailureResult {
  readonly error: string
}

/** One open tab, as `bsk` reports it. */
export interface BrowserTab {
  readonly tabId: number
  readonly title: string
  readonly url: string
  /** The tab the browser currently shows; a tab in a background window is not active. */
  readonly active: boolean
}
