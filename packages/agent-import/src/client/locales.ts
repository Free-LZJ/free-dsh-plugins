/** Locale bundles for the agent-import settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillState } from '../skill-catalog.ts'
import type { SkillSkipReason } from '../skill-import.ts'
import type { SkillSourceId } from '../skill-roots.ts'

/** Locale keys the page renders. */
export type AgentImportLocaleKey =
  | 'title'
  | 'sources' | 'sourcesHint' | 'sourceCodex' | 'sourceClaudeCode'
  | 'skillSources' | 'skillSourcesHint' | 'skillAutoImport' | 'skillAutoImportHint'
  | 'pathsTitle' | 'pathsHint' | 'scopeTitle' | 'scopeHint'
  | 'loadedTitle' | 'loadedHint' | 'loadedSummary' | 'loadedSkills' | 'loadedServers'
  | 'configTitle' | 'viewLabel'
  | 'loadedNoSkills' | 'loadedNoServers' | 'loadedMounted' | 'loadedSkipped' | 'loadedNotes'
  | 'columnName' | 'columnSource' | 'columnPath' | 'columnStatus' | 'columnTarget' | 'columnReason'
  | 'reportLoading' | 'reportUnavailable' | 'refresh'
  | 'mcp' | 'mcpHint' | 'skills' | 'skillsHint' | 'skillAutoImport' | 'skillAutoImportHint'
  | 'failOnStartupError' | 'failOnStartupErrorHint'
  | 'codexIncludeSystemSkills' | 'codexIncludeSystemSkillsHint'
  | 'serverDenyList' | 'serverDenyListHint' | 'denyEntryName' | 'denyEntryRemove' | 'remove' | 'addDenyEntry'
  | 'projectRoot' | 'projectRootHint'
  | 'codexHome' | 'codexHomeHint' | 'codexConfigPath' | 'codexConfigPathHint'
  | 'claudeCodeConfigDir' | 'claudeCodeConfigDirHint'
  | 'claudeCodeConfigPath' | 'claudeCodeConfigPathHint'
  | 'maxServers' | 'maxServersHint' | 'maxSkills' | 'maxSkillsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'
  | 'skillsTitle' | 'skillsTabHint' | 'skillsLoading' | 'skillsUnavailable' | 'skillsOffline'
  | 'skillsEmpty' | 'skillsNotes' | 'skillSearch' | 'skillSearchHint' | 'skillCount' | 'skillRefresh'
  | 'skillImport' | 'skillImportFrom' | 'skillView' | 'skillBack'
  | 'skillContentLoading' | 'skillContentUnavailable' | 'skillContentOffline'
  | 'skillLocal' | 'skillConflict' | 'skillConflictSources' | 'skillInstalledFrom' | 'skillOfferedBy' | 'skillManual'
  | 'skillStateAvailable' | 'skillStateLinked' | 'skillStateLocal' | 'skillStateBroken'
  | 'skipAlreadyInstalled' | 'skipLocalCopy' | 'skipNoSource' | 'skipOccupied'
  | 'skipUnsupported' | 'skipNotALink' | 'skipFailed' | 'skipRemoved'
  | 'skillActionBusy' | 'skillActionImported' | 'skillActionRemoved' | 'skillActionSkipped'
  | 'skillActionNotes' | 'skillActionUnavailable' | 'skillActionOffline'
  | 'skillSourceDsh' | 'skillSourceAgents' | 'skillSourceProject' | 'skillSourceCcSwitch'
  | 'skillSourceCodex' | 'skillSourceClaudeCode' | 'skillSourceGemini' | 'skillSourceOpencode'
  | 'skillSourceCursor' | 'skillSourceCopilot' | 'skillSourceWindsurf' | 'skillSourceWindsurfLegacy'
  | 'skillSourceTrae' | 'skillSourceTraeCn' | 'skillSourceOpenclaw' | 'skillSourceClawdbot'
  | 'skillSourceRoo' | 'skillSourceCodebuddy' | 'skillSourceWorkbuddy' | 'skillSourceQoder'
  | 'skillSourceQoderCn' | 'skillSourceLingma'

/** English copy. */
export const en: Record<AgentImportLocaleKey, string> = {
  title: 'Agent import',
  sources: 'Sources',
  sourcesHint: 'Tools to read, in import precedence order.',
  skillSources: 'Auto-import sources',
  skillSourcesHint: "These tools' skills are linked on activation. The Skills tab lists every known source, and a skill from any other source can still be imported one at a time. dsh's own root is always read, and is the only write target.",
  skillAutoImport: 'Link new skills automatically',
  skillAutoImportHint: 'Links the chosen sources when the plugin activates, and again when that set changes. Turn it off to import every skill by hand.',
  sourceCodex: 'Codex',
  sourceClaudeCode: 'Claude Code',
  pathsTitle: 'Locations',
  pathsHint: "Where each tool keeps its files. Leave a field blank to use that tool's own default.",
  scopeTitle: 'Import scope',
  scopeHint: 'What to import, and how much of it.',
  loadedTitle: 'Loaded',
  loadedHint: "The servers this import mounted, and the skills dsh's own directory now holds. Saving a configuration change rebuilds both.",
  configTitle: 'Configuration',
  viewLabel: 'Card view',
  loadedSummary: '{skills} skills · {servers} MCP servers',
  loadedSkills: 'Skills',
  loadedServers: 'MCP servers',
  loadedNoSkills: 'No skill is imported.',
  loadedNoServers: 'No MCP server is imported.',
  loadedMounted: 'Mounted',
  loadedSkipped: 'Skipped',
  loadedNotes: 'Import notes',
  columnName: 'Name',
  columnSource: 'Source',
  columnPath: 'Instruction file',
  columnStatus: 'Status',
  columnTarget: 'Command or URL',
  columnReason: 'Detail',
  reportLoading: 'Reading the import result…',
  reportUnavailable: 'The import result is unavailable: {reason}',
  refresh: 'Refresh',
  mcp: 'Import MCP servers',
  mcpHint: 'Mount every server the selected tools declare.',
  skills: 'Import skills',
  skillsHint: 'Import and manage skills.',
  failOnStartupError: 'Fail when a server does not start',
  failOnStartupErrorHint: 'Reject plugin activation when one imported server fails to start.',
  codexIncludeSystemSkills: "Include Codex's own skills",
  codexIncludeSystemSkillsHint: "Also import Codex's own bundled `.system` skills.",
  serverDenyList: 'Servers to skip',
  serverDenyListHint: 'Declared server names to leave unmounted. Leave a row blank to drop it.',
  denyEntryName: 'Server name {index}',
  denyEntryRemove: 'Remove server {index}',
  remove: 'Remove',
  addDenyEntry: 'Add server',
  projectRoot: 'Project root',
  projectRootHint: 'Workspace whose project-local configuration is read. Leave blank to use the process working directory.',
  codexHome: 'Codex home',
  codexHomeHint: 'Directory holding Codex config.toml and skills. Leave blank for $CODEX_HOME or ~/.codex.',
  codexConfigPath: 'Codex configuration file',
  codexConfigPathHint: 'Codex config.toml to read. Leave blank for <home>/config.toml.',
  claudeCodeConfigDir: 'Claude Code directory',
  claudeCodeConfigDirHint: 'Directory holding Claude Code skills. Leave blank for $CLAUDE_CONFIG_DIR or ~/.claude.',
  claudeCodeConfigPath: 'Claude Code configuration file',
  claudeCodeConfigPathHint: 'User configuration holding user-scope servers. Leave blank for ~/.claude.json.',
  maxServers: 'Maximum servers',
  maxServersHint: 'Most imported MCP servers to mount.',
  maxSkills: 'Maximum skills',
  maxSkillsHint: 'Most skills one read may hold.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a whole number of 0 or more, or leave blank to use the default.',
  skillsTitle: 'Skills',
  skillsTabHint: 'Every skill name the known tools offer, and what dsh holds for each one. An import links the copy you choose into a dsh root; the tool that owns it keeps its own.',
  skillsLoading: 'Reading the skill catalog…',
  skillsUnavailable: 'The skill catalog is unavailable: {reason}',
  skillsOffline: 'Could not reach the Host to read the skill catalog.',
  skillsEmpty: 'No skill matches.',
  skillsNotes: 'From the scan',
  skillSearch: 'Search skills',
  skillSearchHint: 'Filters by name, description, or source.',
  skillCount: '{shown} of {total}',
  skillRefresh: 'Read again',
  skillImport: 'Import',
  skillImportFrom: 'Import from {source}',
  skillView: 'View instructions',
  skillBack: 'Back to the list',
  skillContentLoading: 'Reading the instruction body…',
  skillContentUnavailable: 'Could not read the body: {reason}',
  skillContentOffline: 'Could not reach the Host to read the body.',
  skillLocal: 'A real directory in a dsh root already owns this name; this page never replaces or removes it.',
  skillConflict: 'More than one source serves this name.',
  skillConflictSources: 'Also offered by {sources}.',
  skillInstalledFrom: 'Imported from {source}',
  skillOfferedBy: 'Offered by {source}',
  skillManual: 'Not auto-imported',
  skillStateAvailable: 'Available',
  skillStateLinked: 'Imported',
  skillStateLocal: 'Local',
  skillStateBroken: 'Broken link',
  skipAlreadyInstalled: 'a link is already in place',
  skipLocalCopy: 'a real local directory owns the name',
  skipNoSource: 'only sources outside the automatic set offer this name',
  skipOccupied: 'something already sits at that path',
  skipUnsupported: 'this platform cannot link that entry',
  skipNotALink: 'that path is not a link, so removing it could delete real files',
  skipFailed: 'the filesystem refused the operation',
  skipRemoved: 'you removed this import, so automatic import leaves it alone',
  skillActionBusy: 'Working on {name}…',
  skillActionImported: 'Imported: {names}',
  skillActionRemoved: 'Removed: {names}',
  skillActionSkipped: 'Left alone:',
  skillActionNotes: 'Notes',
  skillActionUnavailable: 'The action failed: {reason}',
  skillActionOffline: 'Could not reach the Host to change the import.',
  skillSourceDsh: 'dsh',
  skillSourceAgents: 'Agents',
  skillSourceProject: 'Project skills',
  skillSourceCcSwitch: 'CC Switch',
  skillSourceCodex: 'Codex',
  skillSourceClaudeCode: 'Claude Code',
  skillSourceGemini: 'Gemini',
  skillSourceOpencode: 'OpenCode',
  skillSourceCursor: 'Cursor',
  skillSourceCopilot: 'Copilot',
  skillSourceWindsurf: 'Windsurf',
  skillSourceWindsurfLegacy: 'Windsurf (legacy)',
  skillSourceTrae: 'Trae',
  skillSourceTraeCn: 'Trae CN',
  skillSourceOpenclaw: 'OpenClaw',
  skillSourceClawdbot: 'Clawdbot',
  skillSourceRoo: 'Roo',
  skillSourceCodebuddy: 'CodeBuddy',
  skillSourceWorkbuddy: 'WorkBuddy',
  skillSourceQoder: 'Qoder',
  skillSourceQoderCn: 'Qoder CN',
  skillSourceLingma: 'Lingma',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentImportLocaleKey, string> = {
  title: '代理配置导入',
  sources: '来源',
  sourcesHint: '要读取的工具，按导入优先级排列。',
  skillSources: '自动导入来源',
  skillSourcesHint: '激活时把这些工具的技能自动建为链接。技能页会列出所有已知来源的技能，其他来源仍可逐个手动导入。dsh 自己的技能根总是读取，也是唯一的写入目标。',
  skillAutoImport: '自动导入技能',
  skillAutoImportHint: '插件激活时以及自动导入来源变化时，把选中的来源建为链接。关掉后只能逐个手动导入。',
  sourceCodex: 'Codex',
  sourceClaudeCode: 'Claude Code',
  pathsTitle: '路径',
  pathsHint: '各工具存放文件的目录；留空表示使用该工具自身的默认值。',
  scopeTitle: '导入范围',
  scopeHint: '导入哪些内容，以及导入多少。',
  loadedTitle: '已加载',
  loadedHint: '当前这次导入挂载的服务器，以及 dsh 自己技能目录里现有的技能；保存配置后会重建。',
  configTitle: '配置',
  viewLabel: '卡片视图',
  loadedSummary: '{skills} 个技能 · {servers} 个 MCP 服务器',
  loadedSkills: '技能',
  loadedServers: 'MCP 服务器',
  loadedNoSkills: '没有导入任何技能。',
  loadedNoServers: '没有导入任何 MCP 服务器。',
  loadedMounted: '已挂载',
  loadedSkipped: '已跳过',
  loadedNotes: '导入提示',
  columnName: '名称',
  columnSource: '来源',
  columnPath: '指令文件',
  columnStatus: '状态',
  columnTarget: '命令 / URL',
  columnReason: '说明',
  reportLoading: '正在读取导入结果…',
  reportUnavailable: '暂时读不到导入结果：{reason}',
  refresh: '刷新',
  mcp: '导入 MCP 服务器',
  mcpHint: '挂载所选工具声明的每个服务器。',
  skills: '导入技能',
  skillsHint: '是否导入并管理技能。',
  failOnStartupError: '服务器启动失败即报错',
  failOnStartupErrorHint: '某个导入的服务器启动失败时，拒绝激活本插件。',
  codexIncludeSystemSkills: '包含 Codex 自带技能',
  codexIncludeSystemSkillsHint: '连 Codex 自带的 .system 技能一起导入。',
  serverDenyList: '跳过的服务器',
  serverDenyListHint: '不挂载这些已声明的服务器名；留空该行即删除。',
  denyEntryName: '服务器名 {index}',
  denyEntryRemove: '移除服务器 {index}',
  remove: '移除',
  addDenyEntry: '添加服务器',
  projectRoot: '项目根目录',
  projectRootHint: '读取项目级配置的工作区；留空表示使用进程工作目录。',
  codexHome: 'Codex 主目录',
  codexHomeHint: '存放 Codex config.toml 与 skills 的目录；留空表示 $CODEX_HOME 或 ~/.codex。',
  codexConfigPath: 'Codex 配置文件',
  codexConfigPathHint: '要读取的 Codex config.toml；留空表示 <home>/config.toml。',
  claudeCodeConfigDir: 'Claude Code 目录',
  claudeCodeConfigDirHint: '存放 Claude Code 技能的目录；留空表示 $CLAUDE_CONFIG_DIR 或 ~/.claude。',
  claudeCodeConfigPath: 'Claude Code 配置文件',
  claudeCodeConfigPathHint: '存放用户级服务器的配置文件；留空表示 ~/.claude.json。',
  maxServers: '服务器上限',
  maxServersHint: '最多挂载多少个导入的 MCP 服务器。',
  maxSkills: '技能上限',
  maxSkillsHint: '一次最多读取多少个技能。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填 0 或更大的整数；留空表示使用默认值。',
  skillsTitle: '技能',
  skillsTabHint: '各个已知工具提供的全部技能名，以及 dsh 当前为每个名字保留的副本。导入只是把选中的那一份链接进 dsh 技能目录，原工具仍保留自己的副本。',
  skillsLoading: '正在读取技能列表…',
  skillsUnavailable: '读不到技能列表：{reason}',
  skillsOffline: '连接不到 Host，无法读取技能列表。',
  skillsEmpty: '没有匹配的技能。',
  skillsNotes: '扫描提示',
  skillSearch: '搜索技能',
  skillSearchHint: '按名称、说明或来源筛选。',
  skillCount: '共 {total} 个，显示 {shown} 个',
  skillRefresh: '重新读取',
  skillImport: '导入',
  skillImportFrom: '从 {source} 导入',
  skillView: '查看正文',
  skillBack: '返回列表',
  skillContentLoading: '正在读取正文…',
  skillContentUnavailable: '读不到正文：{reason}',
  skillContentOffline: '连接不到 Host，无法读取正文。',
  skillLocal: 'dsh 技能目录里已有同名真实目录，本页不会替换或移除它。',
  skillConflict: '多个来源提供这个技能名。',
  skillConflictSources: '另外还由 {sources} 提供。',
  skillInstalledFrom: '已从 {source} 导入',
  skillOfferedBy: '由 {source} 提供',
  skillManual: '不自动导入',
  skillStateAvailable: '可导入',
  skillStateLinked: '已导入',
  skillStateLocal: '本地',
  skillStateBroken: '链接失效',
  skipAlreadyInstalled: '已经存在链接',
  skipLocalCopy: '本地已有同名真实目录',
  skipNoSource: '只有自动导入来源之外的来源提供这个名字',
  skipOccupied: '该路径已被占用',
  skipUnsupported: '当前平台无法为该条目建立链接',
  skipNotALink: '该路径不是链接，移除可能删掉真实文件',
  skipFailed: '文件系统拒绝了该操作',
  skipRemoved: '你已移除这个导入，自动导入不会再带回来',
  skillActionBusy: '正在处理 {name}…',
  skillActionImported: '已导入：{names}',
  skillActionRemoved: '已移除：{names}',
  skillActionSkipped: '未改动：',
  skillActionNotes: '提示',
  skillActionUnavailable: '操作失败：{reason}',
  skillActionOffline: '连接不到 Host，无法修改导入。',
  skillSourceDsh: 'dsh',
  skillSourceAgents: 'Agents',
  skillSourceProject: '项目技能',
  skillSourceCcSwitch: 'CC Switch',
  skillSourceCodex: 'Codex',
  skillSourceClaudeCode: 'Claude Code',
  skillSourceGemini: 'Gemini',
  skillSourceOpencode: 'OpenCode',
  skillSourceCursor: 'Cursor',
  skillSourceCopilot: 'Copilot',
  skillSourceWindsurf: 'Windsurf',
  skillSourceWindsurfLegacy: 'Windsurf（旧版）',
  skillSourceTrae: 'Trae',
  skillSourceTraeCn: 'Trae 国内版',
  skillSourceOpenclaw: 'OpenClaw',
  skillSourceClawdbot: 'Clawdbot',
  skillSourceRoo: 'Roo',
  skillSourceCodebuddy: 'CodeBuddy',
  skillSourceWorkbuddy: 'WorkBuddy',
  skillSourceQoder: 'Qoder',
  skillSourceQoderCn: 'Qoder 国内版',
  skillSourceLingma: 'Lingma',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: AgentImportLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/**
 * Locale key naming each catalog source, so a row shows the tool in the active
 * language rather than the English label the Host sends with its offerings.
 *
 * Complete on purpose: a source added to the Host's union without copy here
 * fails the typecheck instead of quietly rendering an English name.
 */
const SKILL_SOURCE_KEYS: Record<SkillSourceId, AgentImportLocaleKey> = {
  dsh: 'skillSourceDsh',
  agents: 'skillSourceAgents',
  project: 'skillSourceProject',
  'cc-switch': 'skillSourceCcSwitch',
  codex: 'skillSourceCodex',
  'claude-code': 'skillSourceClaudeCode',
  gemini: 'skillSourceGemini',
  opencode: 'skillSourceOpencode',
  cursor: 'skillSourceCursor',
  copilot: 'skillSourceCopilot',
  windsurf: 'skillSourceWindsurf',
  'windsurf-legacy': 'skillSourceWindsurfLegacy',
  trae: 'skillSourceTrae',
  'trae-cn': 'skillSourceTraeCn',
  openclaw: 'skillSourceOpenclaw',
  clawdbot: 'skillSourceClawdbot',
  roo: 'skillSourceRoo',
  codebuddy: 'skillSourceCodebuddy',
  workbuddy: 'skillSourceWorkbuddy',
  qoder: 'skillSourceQoder',
  'qoder-cn': 'skillSourceQoderCn',
  lingma: 'skillSourceLingma',
}

/** The same mapping keyed loosely, so a source this build does not know still renders. */
const SKILL_SOURCE_KEY_BY_ID = new Map<string, AgentImportLocaleKey>(Object.entries(SKILL_SOURCE_KEYS))

/** Locale key naming each state a catalog row can be in. */
const SKILL_STATE_KEYS: Record<SkillState, AgentImportLocaleKey> = {
  available: 'skillStateAvailable',
  linked: 'skillStateLinked',
  local: 'skillStateLocal',
  broken: 'skillStateBroken',
}

/** Locale key explaining each reason an operation left a name alone. */
const SKILL_SKIP_KEYS: Record<SkillSkipReason, AgentImportLocaleKey> = {
  'already-installed': 'skipAlreadyInstalled',
  'local-copy': 'skipLocalCopy',
  'no-source': 'skipNoSource',
  occupied: 'skipOccupied',
  unsupported: 'skipUnsupported',
  'not-a-link': 'skipNotALink',
  failed: 'skipFailed',
  removed: 'skipRemoved',
}

/**
 * The copy naming one catalog source.
 * @param t - the page's locale reader.
 * @param source - the id the Host sent with an offering.
 * @param label - the English label the Host sent with it.
 * @returns the localized name, or the Host's own label when this build does not know the id.
 */
export function skillSourceLabel(
  t: (key: AgentImportLocaleKey) => string,
  source: string,
  label: string,
): string {
  const key = SKILL_SOURCE_KEY_BY_ID.get(source)
  return key === undefined ? label : t(key)
}

/**
 * The copy naming one row's state.
 * @param t - the page's locale reader.
 * @param state - the state the catalog reported.
 * @returns the localized state name, which is also the tag's text.
 */
export function skillStateLabel(t: (key: AgentImportLocaleKey) => string, state: SkillState): string {
  return t(SKILL_STATE_KEYS[state])
}

/**
 * The copy explaining why an operation left one name alone.
 * @param t - the page's locale reader.
 * @param reason - the reason the Host reported.
 * @returns the localized explanation, which the row shows beside the name.
 */
export function skillSkipLabel(t: (key: AgentImportLocaleKey) => string, reason: SkillSkipReason): string {
  return t(SKILL_SKIP_KEYS[reason])
}
