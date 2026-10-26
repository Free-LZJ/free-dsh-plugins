/**
 * Worktree picker copy, in the two locales the shell ships.
 *
 * @module @deepseek-lzj/dsh-worktree/client/locales
 */

/** Dictionary namespace owned by this plugin; also the Loader row id. */
export const NS = 'worktree'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  trigger: '新建工作树会话',
  title: '在新工作树中开始',
  description: '从当前仓库的最新提交建一个独立检出，新会话在检出里运行，原检出与工作区都不受影响。',
  nameLabel: '名称',
  namePlaceholder: '留空则自动命名',
  location: '位置：{path}',
  cancel: '取消',
  create: '创建并开始',
  busy: '正在创建…',
  failed: '创建失败',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<WorktreeKey, string> = {
  trigger: 'New worktree session',
  title: 'Start in a new worktree',
  description: 'Branch a separate checkout from the repository’s latest commit. The session runs there; the original checkout and workspace stay untouched.',
  nameLabel: 'Name',
  namePlaceholder: 'Generated when left blank',
  location: 'Location: {path}',
  cancel: 'Cancel',
  create: 'Create and start',
  busy: 'Creating…',
  failed: 'Creation failed',
}

/** Key domain of the `worktree` namespace (zh is the source of truth). */
export type WorktreeKey = keyof typeof zh
