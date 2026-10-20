/**
 * Panel copy, in the two locales the shell ships.
 *
 * Only the strings the shell itself draws live here: the sidebar entry's label,
 * the frame's accessible name, and the two the workbench reads when it lists
 * this panel. Everything inside the framed document is written in the document,
 * which the Host serves and the shell never re-renders on a locale switch.
 *
 * @module @free-lzj/dsh-mail/client/locales
 */

/** Chinese copy: the panel's primary language. */
export const zh = {
  panel: '邮件',
  title: '邮件面板',
  description: '读、搜、标已读、星标与删除，新邮件可按规则交给 agent',
}

/** English copy for the sidebar entry and the frame's accessible name. */
export const en = {
  panel: 'Mail',
  title: 'Mail panel',
  description: 'Read, search, flag and delete; hand new mail to an agent by rule',
}

/** The keys this namespace defines. */
export type MailLocaleKey = keyof typeof zh
