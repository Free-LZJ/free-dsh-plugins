/**
 * Panel copy, in the two locales the shell ships.
 *
 * @module @free-lzj/dsh-directory-guide/client/locales
 */

/** Chinese copy: the primary language of the notes the panel renders. */
export const zh = {
  panel: '.dsh 目录说明',
  title: '.dsh 目录说明',
}

/** English copy for the sidebar entry and the frame's accessible name. */
export const en = {
  panel: 'DSH home directory',
  title: 'DSH home directory',
}

/** The keys this namespace defines. */
export type GuideLocaleKey = keyof typeof zh
