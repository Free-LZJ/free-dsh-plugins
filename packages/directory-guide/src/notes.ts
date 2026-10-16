/**
 * What every entry directly under the DSH home directory is, and what a
 * reinstall should do with it.
 *
 * These are the human answers the directory listing can't work out by itself:
 * `sessions` and `profiles` hold the only copies of anything, `electron` and
 * `dsh-runtimes` are rebuilt from a download, and a SQLite sidecar file has no
 * meaning apart from its main database.
 *
 * @module @free-lzj/dsh-directory-guide/notes
 */

/** What a reinstall should do with one entry. Also the listing's filter vocabulary. */
export type Advice = '保留' | '可重建' | '需核对' | '按需保留' | '随主库'

/** The hand-written answer for one entry directly under the DSH home directory. */
export interface TopNote {
  /** Entry name as it appears on disk. */
  readonly name: string
  /** What this entry holds and what losing it costs. */
  readonly note: string
  /** What a reinstall should do with it. */
  readonly advice: Advice
}

/**
 * Every entry directly under `~/.dsh`, as the listing annotates it.
 *
 * A name that no longer exists on disk is simply never matched; a new entry
 * with no note here falls back to the generic description in the panel.
 */
export const TOP_NOTES: readonly TopNote[] = [
  { name: 'attachments', advice: '保留', note: '对话附件仓库；v1/objects 存原始文件，v1/tmp 是落地临时区。删掉后历史对话里的图片与文件会打不开' },
  { name: 'dsh-pet', advice: '按需保留', note: '桌面宠物插件状态：main-config.jsonc 是配置，memory.json 是宠物记忆；插件本身可重装' },
  { name: 'dsh-runtimes', advice: '可重建', note: 'DSH 运行时与依赖（dsh-primary-runtime）；约 272 MB，重装会按版本重新下载' },
  { name: 'electron', advice: '可重建', note: 'Electron 桌面外壳二进制与 Chromium 资源；约 347 MB，重装时重新解包' },
  { name: 'logs', advice: '可重建', note: '启动与运行日志；排障完即可清空，下次启动自动新建' },
  { name: 'memory-archive', advice: '保留', note: '长期记忆归档区（当前只有 codex 子目录）；清理前先确认内容已导出' },
  { name: 'plugin-tarballs', advice: '可重建', note: '插件包与市场下载缓存，按版本分目录；删掉后重新安装插件会再下载' },
  { name: 'profiles', advice: '保留', note: '配置档案根目录（desktop / web / 自建 profile 各一份）：cordis.patch.yml、package.json、node_modules、插件配置都在里面，重装最需要保住的就是它' },
  { name: 'sessions', advice: '保留', note: '会话记录区，按工作目录分桶、每次会话一个目录；含对话正文，删除不可恢复' },
  { name: 'skills', advice: '保留', note: '技能库，每个技能一个目录（SKILL.md + scripts）；自建技能删掉要重写' },
  { name: 'storages', advice: '需核对', note: '插件与工作区状态存储：plugin-store 是插件库（SQLite），另有 workspace.json、session_projcache 等缓存；数据库边车文件需随主库处理' },
  { name: '.anonymous-user-id', advice: '可重建', note: '匿名统计标识；删掉会重新生成，历史统计对不上' },
  { name: '.credentials.yaml', advice: '保留', note: '登录凭据与模型 API Key 的记录（预览会整体遮盖正文）；重装前先备份' },
  { name: 'AGENTS.md', advice: '保留', note: '用户全局指令，每次会话都会注入；重装时必须保留' },
  { name: 'pet.json', advice: '可重建', note: '桌面宠物进度（宠物 ID、亲密度、喂食时间）；删掉宠物从头开始' },
  { name: 'settings.yaml.imported', advice: '需核对', note: '从旧版本导入设置留下的快照；确认新设置已生效后可清理' },
]

/**
 * The answer for an entry deeper in the tree, matched by relative path.
 *
 * Only the shapes worth naming are listed. Everything else keeps the panel's
 * generic description and inherits its parent directory's advice.
 * @param rel - slash-joined path below the home directory, e.g. `sessions/<id>`.
 * @param isDirectory - whether the entry is a directory.
 * @returns the note and advice to show, or null to keep the generic ones.
 */
export function annotate(rel: string, isDirectory: boolean): { note?: string; advice?: Advice } | null {
  if (!isDirectory) {
    if (/^storages\/plugin-store\/plugin-store\.sqlite$/.test(rel)) return { note: '插件库主文件（SQLite）；不能当普通文本展开', advice: '需核对' }
    if (/^storages\/plugin-store\/plugin-store\.sqlite-(wal|shm)$/.test(rel)) return { note: 'SQLite 边车文件；必须跟主库一起处理，不能单独删', advice: '随主库' }
    if (/^logs\/[^/]+\.log$/.test(rel)) return { note: '历史启动日志；排障完即可清空', advice: '可重建' }
  }
  if (/^sessions\/[^/]+\/[^/]+$/.test(rel)) return { note: '单次会话记录；含该次对话正文与工具调用', advice: '保留' }
  if (/^sessions\/[^/]+$/.test(rel)) return { note: '按工作目录分桶的会话目录；每次会话一个子目录', advice: '保留' }
  if (/^profiles\/[^/]+$/.test(rel)) return { note: 'profile 配置档案：cordis.patch.yml、package.json、插件依赖都在这一层', advice: '保留' }
  if (/^skills\/[^/]+$/.test(rel)) return { note: '技能目录（SKILL.md 说明 + scripts）', advice: '保留' }
  if (/^plugin-tarballs\//.test(rel)) return { advice: '可重建' }
  if (/^electron(\/|$)/.test(rel)) return { note: 'Electron 外壳的二进制与资源文件', advice: '可重建' }
  if (/^dsh-runtimes(\/|$)/.test(rel)) return { note: 'DSH 运行时与依赖', advice: '可重建' }
  if (/^attachments\//.test(rel)) return { advice: '保留' }
  if (/^memory-archive\//.test(rel)) return { advice: '保留' }
  return null
}
