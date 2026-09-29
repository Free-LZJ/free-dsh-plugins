/** Locale bundles for the agent-import settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type AgentImportLocaleKey =
  | 'title' | 'summary'
  | 'sources' | 'sourcesHint' | 'sourceCodex' | 'sourceClaudeCode'
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
