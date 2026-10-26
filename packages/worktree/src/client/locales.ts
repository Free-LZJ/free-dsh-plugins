/**
 * Worktree picker copy, in the two locales the shell ships.
 *
 * @module @free-lzj/dsh-worktree/client/locales
 */

/** Dictionary namespace owned by this plugin; also the Loader row id. */
export const NS = 'worktree'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  trigger: '工作树',
  title: '工作树',
  description: '每个工作树是一个独立检出：在里面开的会话不碰原检出，原检出也不碰它。',
  nameLabel: '新工作树名称',
  namePlaceholder: '留空则自动命名',
  location: '位置：{path}',
  cancel: '关闭',
  create: '创建并开始',
  busy: '正在创建…',
  failed: '操作失败',
  listTitle: '已有工作树',
  listLoading: '读取中…',
  listEmpty: '还没有工作树。',
  enter: '进入',
  remove: '删除',
  removeConfirm: '确认删除',
  branchless: '（分离头）',
  mainCheckout: '主检出',
  external: '外部检出',
  listed: '共 {count} 个',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<WorktreeKey, string> = {
  trigger: 'Worktrees',
  title: 'Worktrees',
  description: 'Each worktree is a separate checkout: sessions inside it leave the original checkout alone, and it leaves them alone.',
  nameLabel: 'New worktree name',
  namePlaceholder: 'Generated when left blank',
  location: 'Location: {path}',
  cancel: 'Close',
  create: 'Create and start',
  busy: 'Creating…',
  failed: 'Operation failed',
  listTitle: 'Existing worktrees',
  listLoading: 'Reading…',
  listEmpty: 'No worktrees yet.',
  enter: 'Enter',
  remove: 'Remove',
  removeConfirm: 'Confirm removal',
  branchless: '(detached)',
  mainCheckout: 'Main checkout',
  external: 'External checkout',
  listed: '{count} in total',
}

/** Key domain of the `worktree` namespace (zh is the source of truth). */
export type WorktreeKey = keyof typeof zh
