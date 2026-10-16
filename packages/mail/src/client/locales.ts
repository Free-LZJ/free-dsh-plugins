/**
 * Panel copy, in the two locales the shell ships.
 *
 * Only the two strings the shell itself draws live here: the sidebar entry's
 * label and the frame's accessible name. Everything inside the framed document
 * is written in the document, which the Host serves and the shell never
 * re-renders on a locale switch.
 *
 * @module @free-lzj/dsh-mail/client/locales
 */

/** Chinese copy: the panel's primary language. */
export const zh = {
  panel: '邮件',
  title: '邮件面板',
}

/** English copy for the sidebar entry and the frame's accessible name. */
export const en = {
  panel: 'Mail',
  title: 'Mail panel',
}

/** The keys this namespace defines. */
export type MailLocaleKey = keyof typeof zh
