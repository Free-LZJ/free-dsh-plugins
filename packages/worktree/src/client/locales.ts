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
  dismiss: '知道了',
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
  createHere: '新建',

  removeTitle: '删除工作树',
  removeDescription: '删除后这个检出和它的分支都会消失，无法恢复。',
  removePath: '检出',
  removeBranch: '分支',
  removeClean: '这个检出没有未提交改动。',
  removeDirty: '这个检出有 {count} 处未提交改动，普通删除会被 Git 拒绝。强制删除会丢弃这些改动。',
  forceRemove: '强制删除',
  forceRemoveHint: '强制删除会丢弃上面这些未提交改动，且无法撤销。',
  dirtyCount: '{count} 处改动',

  unresolvedTitle: '未归属的工作区',
  unresolvedHint: '这些目录还挂在工作区列表里，但已经找不到对应的检出——通常是检出在外面被删掉了。移除注册只删这一行，不动磁盘上的任何文件。',
  unresolvedCount: '{count} 个',
  unresolvedMissing: '目录已不存在',
  unresolvedNotRepo: '不是仓库',
  unresolvedForget: '移除注册',

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
  dismiss: 'Dismiss',
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
  createHere: 'New',

  removeTitle: 'Remove worktree',
  removeDescription: 'The checkout and its branch are both gone afterwards, with no way back.',
  removePath: 'Checkout',
  removeBranch: 'Branch',
  removeClean: 'This checkout has no uncommitted changes.',
  removeDirty: 'This checkout has {count} uncommitted changes, so Git will refuse a plain removal. Forcing it discards those changes.',
  forceRemove: 'Remove anyway',
  forceRemoveHint: 'Removing anyway discards the uncommitted changes above and cannot be undone.',
  dirtyCount: '{count} changes',

  unresolvedTitle: 'Unattached workspaces',
  unresolvedHint: 'These directories are still registered as workspaces, but no checkout answers for them — usually because the checkout was deleted elsewhere. Removing the registration only drops this row; nothing on disk is touched.',
  unresolvedCount: '{count}',
  unresolvedMissing: 'Directory missing',
  unresolvedNotRepo: 'Not a repository',
  unresolvedForget: 'Remove registration',

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
