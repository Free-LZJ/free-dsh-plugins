/**
 * The `@` menu's copy for this plugin.
 *
 * Only the section heading needs translating: every row's text is the user's own
 * page title, which no dictionary can hold.
 *
 * @module @free-lzj/dsh-browser-use/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'browserUse'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  sectionBrowser: '浏览器',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<BrowserUseKey, string> = {
  sectionBrowser: 'Browser',
}

/** Key domain of the `browserUse` namespace. */
export type BrowserUseKey = keyof typeof zh
