/**
 * The `@` menu's copy for this plugin.
 *
 * Only two things need translating: the section heading, and the row that
 * explains why the section is missing. Every other row's text is the user's own
 * page title, which no dictionary can hold.
 *
 * @module @free-lzj/dsh-browser-use/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'browserUse'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  sectionBrowser: '浏览器',
  unavailable: '浏览器不可用',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<BrowserUseKey, string> = {
  sectionBrowser: 'Browser',
  unavailable: 'Browser unavailable',
}

/** Key domain of the `browserUse` namespace. */
export type BrowserUseKey = keyof typeof zh
