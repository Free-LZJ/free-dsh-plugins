/**
 * Worktree manager copy, in the two locales the shell ships.
 *
 * @module @free-lzj/dsh-worktree/client/locales
 */

/** Dictionary namespace owned by this plugin; also the Loader row id. */
export const NS = 'worktree'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  trigger: '工作树',
  createTitle: '新建工作树会话',
  createDescription: '从当前仓库的最新提交建一个独立检出，新会话在检出里运行，原检出不受影响。',
  nameLabel: '名称',
  namePlaceholder: '留空则自动命名',
  location: '位置：{path}',
  cancel: '取消',
  create: '创建并开始',
  busy: '处理中…',

  panel: '工作树',
  panelTitle: '工作树',
  refresh: '刷新',
  manage: '管理',
  loading: '读取中…',
  empty: '还没有任何仓库工作区。先在侧边栏添加一个工作区。',
  repoEmpty: '这个仓库还没有工作树。',
  worktreeCount: '{count} 个工作树',
  mainCheckout: '主检出',
  locked: '已锁定',
  detached: '（分离头）',
  enter: '进入',
  remove: '删除',
  removeConfirm: '确认删除',
  createHere: '新建',

  settingsTitle: '设置',
  settingsParent: '工作树目录',
  settingsParentPlaceholder: '留空 = <仓库>/.agents/worktrees',
  settingsParentHint: '留空时检出放在各自仓库内。填绝对路径时，每个仓库一个子目录。',
  settingsFetch: '创建前拉取上游更新',
  settingsFetchHint: '开启后先 git fetch --all --prune，新分支从当前分支的上游起。',
  settingsSave: '保存',
  settingsSaved: '已保存',

  failed: '操作失败',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<WorktreeKey, string> = {
  trigger: 'Worktrees',
  createTitle: 'New worktree session',
  createDescription: 'Branch a separate checkout from the repository’s latest commit. The session runs there; the original checkout stays untouched.',
  nameLabel: 'Name',
  namePlaceholder: 'Generated when left blank',
  location: 'Location: {path}',
  cancel: 'Cancel',
  create: 'Create and start',
  busy: 'Working…',

  panel: 'Worktrees',
  panelTitle: 'Worktrees',
  refresh: 'Refresh',
  manage: 'Manage',
  loading: 'Reading…',
  empty: 'No repository workspace yet. Add one from the sidebar first.',
  repoEmpty: 'This repository has no worktrees yet.',
  worktreeCount: '{count} worktrees',
  mainCheckout: 'Main checkout',
  locked: 'Locked',
  detached: '(detached)',
  enter: 'Enter',
  remove: 'Remove',
  removeConfirm: 'Confirm',
  createHere: 'New',

  settingsTitle: 'Settings',
  settingsParent: 'Worktree directory',
  settingsParentPlaceholder: 'Empty = <repo>/.agents/worktrees',
  settingsParentHint: 'Empty keeps checkouts inside each repository. An absolute path creates one subdirectory per repository there.',
  settingsFetch: 'Fetch upstream before creating',
  settingsFetchHint: 'Runs git fetch --all --prune first, then starts the branch at the current upstream.',
  settingsSave: 'Save',
  settingsSaved: 'Saved',

  failed: 'Operation failed',
}

/** Key domain of the `worktree` namespace (zh is the source of truth). */
export type WorktreeKey = keyof typeof zh
