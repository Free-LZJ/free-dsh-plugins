/** Locale bundles for the agent-import settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type AgentImportLocaleKey =
  | 'title' | 'summary'
  | 'sources' | 'sourcesHint' | 'sourceCodex' | 'sourceClaudeCode'
  | 'pathsTitle' | 'pathsHint' | 'scopeTitle' | 'scopeHint'
  | 'loadedTitle' | 'loadedHint' | 'loadedSummary' | 'loadedSkills' | 'loadedServers'
  | 'loadedNoSkills' | 'loadedNoServers' | 'loadedMounted' | 'loadedSkipped' | 'loadedNotes'
  | 'reportLoading' | 'reportUnavailable' | 'refresh'
  | 'mcp' | 'mcpHint' | 'skills' | 'skillsHint'
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

/** English copy. */
export const en: Record<AgentImportLocaleKey, string> = {
  title: 'Agent import',
  summary: 'Import the MCP servers and skills Codex or Claude Code already declares.',
  sources: 'Sources',
  sourcesHint: 'Tools to read, in import precedence order.',
  sourceCodex: 'Codex',
  sourceClaudeCode: 'Claude Code',
  pathsTitle: 'Locations',
  pathsHint: "Where each tool keeps its files. Leave a field blank to use that tool's own default.",
  scopeTitle: 'Import scope',
  scopeHint: 'What to import, and how much of it.',
  loadedTitle: 'Loaded',
  loadedHint: 'What the current import mounted and published. Editing any setting above rebuilds it.',
  loadedSummary: '{skills} skills · {servers} MCP servers',
  loadedSkills: 'Skills',
  loadedServers: 'MCP servers',
  loadedNoSkills: 'No skill is imported.',
  loadedNoServers: 'No MCP server is imported.',
  loadedMounted: 'Mounted',
  loadedSkipped: 'Skipped',
  loadedNotes: 'Import notes',
  reportLoading: 'Reading the import result…',
  reportUnavailable: 'The import result is unavailable: {reason}',
  refresh: 'Refresh',
  mcp: 'Import MCP servers',
  mcpHint: 'Mount every server the selected tools declare.',
  skills: 'Import skills',
  skillsHint: 'Publish the skill directories the selected tools own.',
  failOnStartupError: 'Fail when a server does not start',
  failOnStartupErrorHint: 'Reject plugin activation when one imported server fails to start.',
  codexIncludeSystemSkills: "Include Codex's own skills",
  codexIncludeSystemSkillsHint: "Also publish Codex's own bundled system skills.",
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
  maxSkillsHint: 'Most imported skills to publish.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a whole number of 0 or more, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentImportLocaleKey, string> = {
  title: '代理配置导入',
  summary: '导入 Codex 或 Claude Code 已经声明的 MCP 服务器与技能。',
  sources: '来源',
  sourcesHint: '要读取的工具，按导入优先级排列。',
  sourceCodex: 'Codex',
  sourceClaudeCode: 'Claude Code',
  pathsTitle: '路径',
  pathsHint: '各工具存放文件的目录；留空表示使用该工具自身的默认值。',
  scopeTitle: '导入范围',
  scopeHint: '导入哪些内容，以及导入多少。',
  loadedTitle: '已加载',
  loadedHint: '当前这次导入实际挂载的服务器与发布的技能；改动上面任何设置都会自动重建。',
  loadedSummary: '{skills} 个技能 · {servers} 个 MCP 服务器',
  loadedSkills: '技能',
  loadedServers: 'MCP 服务器',
  loadedNoSkills: '没有导入任何技能。',
  loadedNoServers: '没有导入任何 MCP 服务器。',
  loadedMounted: '已挂载',
  loadedSkipped: '已跳过',
  loadedNotes: '导入提示',
  reportLoading: '正在读取导入结果…',
  reportUnavailable: '暂时读不到导入结果：{reason}',
  refresh: '刷新',
  mcp: '导入 MCP 服务器',
  mcpHint: '挂载所选工具声明的每个服务器。',
  skills: '导入技能',
  skillsHint: '发布所选工具自有的技能目录。',
  failOnStartupError: '服务器启动失败即报错',
  failOnStartupErrorHint: '某个导入的服务器启动失败时，拒绝激活本插件。',
  codexIncludeSystemSkills: '包含 Codex 自带技能',
  codexIncludeSystemSkillsHint: '同时发布 Codex 自带的 .system 技能。',
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
  maxSkillsHint: '最多发布多少个导入的技能。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填 0 或更大的整数；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: AgentImportLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
