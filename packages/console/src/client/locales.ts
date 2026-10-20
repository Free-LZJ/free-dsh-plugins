/**
 * Workbench copy, in the two locales the shell ships.
 *
 * One dictionary for the whole workbench: the home list, the header tools, the
 * notification centre and the settings row draw from it, so a new surface adds
 * keys here and nowhere else.
 *
 * @module @free-lzj/dsh-console/client/locales
 */

/** Chinese copy: the workbench's primary language. */
export const zh = {
  panel: '工作台',
  title: '工作台',
  search: '搜索插件',
  searchEmpty: '没有匹配的插件',
  searchEmptyHint: '换个关键词，或清除搜索。',
  listEmpty: '还没有可用的插件',
  listEmptyHint: '按工作台面板契约接入的插件会出现在这里。',
  layout: '布局',
  layoutGrid: '宫格',
  layoutList: '列表',
  layoutCompact: '紧凑',
  cardActions: '更多操作',
  pin: '置顶',
  unpin: '取消置顶',
  noticeTitle: '通知',
  noticeEmpty: '暂无通知',
  noticeClear: '清空',
  noticeBadge: '有 {count} 条未读通知',
  noticePermissionDenied: '浏览器通知权限被拒绝，桌面通知不会出现',
  noticeUnavailable: '当前环境不支持桌面通知',
  settingsTitle: '通知',
  settingsHint: '选择工作台用哪些方式提醒你；调用工作台通知接口的插件都按这里生效。',
  channelDesktop: '桌面通知',
  channelDesktopHint: '在 Windows 通知中心弹出（需要浏览器通知权限）',
  channelInapp: '应用内消息',
  channelInappHint: '工作台通知中心与角标',
  channelSound: '提示音',
  channelSoundHint: '播放一声短提示',
  settingsSaved: '已保存',
  settingsFailed: '保存失败，请重试',
  settingsLocked: '至少保留一个通知方式',
} as const

/** English copy for the same keys. */
export const en: Record<keyof typeof zh, string> = {
  panel: 'Workbench',
  title: 'Workbench',
  search: 'Search panels',
  searchEmpty: 'No panel matches',
  searchEmptyHint: 'Try another term, or clear the search.',
  listEmpty: 'No panels yet',
  listEmptyHint: 'Plugins that adopt the workbench panel contract show up here.',
  layout: 'Layout',
  layoutGrid: 'Grid',
  layoutList: 'List',
  layoutCompact: 'Compact',
  cardActions: 'More actions',
  pin: 'Pin',
  unpin: 'Unpin',
  noticeTitle: 'Notices',
  noticeEmpty: 'No notices yet',
  noticeClear: 'Clear',
  noticeBadge: '{count} unread notices',
  noticePermissionDenied: 'Browser notification permission is denied; desktop notices will not appear',
  noticeUnavailable: 'Desktop notifications are unavailable here',
  settingsTitle: 'Notifications',
  settingsHint: 'Pick how the workbench reaches you. Every plugin that notifies through it follows this choice.',
  channelDesktop: 'Desktop notifications',
  channelDesktopHint: 'Pop up through the Windows notification centre (needs browser permission)',
  channelInapp: 'In-app messages',
  channelInappHint: 'The workbench notice centre and its badge',
  channelSound: 'Sound',
  channelSoundHint: 'Play a short tone',
  settingsSaved: 'Saved',
  settingsFailed: 'Save failed; try again',
  settingsLocked: 'Keep at least one notification channel',
}

/** The keys this namespace defines. */
export type ConsoleLocaleKey = keyof typeof zh

/**
 * Translate one key of this namespace, with `{name}` interpolation.
 *
 * The seat the workbench's own surfaces take. Declared here rather than as the
 * framework's `PropsLocale<'console'>` so a component can be driven by a spec
 * (and by the settings row's simpler surface) without the slot machinery.
 * @param key - a key of the workbench dictionary.
 * @param params - values for the placeholders.
 * @returns the localized text.
 */
export type Translate = (key: ConsoleLocaleKey, params?: Record<string, unknown>) => string
