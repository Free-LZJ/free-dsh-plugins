/**
 * 邮件这一侧的词表：哪些条件、哪些动作存在，每个字段怎么收窄，以及三态的默认值。
 *
 * 「结构」那部分（顶层是不是数组、name 有没有、id 重不重复、priority 是不是整数）
 * 在 `@free-lzj/dsh-decision` 的 `config.ts` 里；这里只回答内核不知道的事：
 * **一封邮件的 `from` 条件该带什么字段、`move` 动作必须有文件夹**。
 *
 * **丢弃而不整体失败**是刻意的：一份 20 条的文件里有一条写歪，用户要的是另外 19 条
 * 继续工作，而不是整个分诊停摆。
 *
 * @module @free-lzj/dsh-mail/triage/config
 */

import {
  DEFAULT_DECISION_CONFIG, DEFAULT_RUN_HISTORY_LIMIT, DEFAULT_RUN_RETENTION_DAYS, DEFAULT_UNDO_WINDOW_SECONDS,
  MAX_INSTRUCTIONS_LENGTH, MAX_MATCH_LENGTH, MAX_NAME_LENGTH, MAX_PATTERN_LENGTH, MAX_TITLE_LENGTH,
  MAX_UNDO_WINDOW_SECONDS, clamped, integer, named, normalizeDecisionConfig, normalizeRules as normalizeRuleList,
  stringList, type RuleVocabulary,
} from '@free-lzj/dsh-decision'
import { isRecord, text } from '@free-lzj/dsh-decision'
import type {
  ActionKind, ActionMode, ActionSpec, ConditionKind, ConditionSpec, Config, Rule,
} from './types.ts'

export { isRecord, text }

/** 条件种类名；写歪的 kind 会被丢弃。 */
const CONDITION_KINDS = new Set<string>([
  'from', 'to', 'subject', 'body', 'header', 'regex', 'attachment', 'classifier',
] satisfies ConditionKind[])

/** 动作种类名。 */
const ACTION_KINDS = new Set<string>([
  'markRead', 'flag', 'move', 'archive', 'notify', 'session', 'followup', 'script', 'mcp', 'http',
] satisfies ActionKind[])

/** 动作三态。 */
const ACTION_MODES = new Set<string>(['auto', 'suggest', 'off'] satisfies ActionMode[])

/** 语气。 */
const TONES = new Set<string>(['info', 'success', 'warn', 'error'])

/**
 * 不可撤销的动作默认只「建议」。
 *
 * 判据是**能不能撤销**，不是「危险不危险」：标记已读可以标回去、移动可以移回来，
 * 而跑一个脚本、调一次 MCP、发一个 HTTP 请求都收不回来。默认值只是起点，规则
 * 里写 `mode` 就能覆盖。
 */
const DEFAULT_MODE: Readonly<Record<ActionKind, ActionMode>> = {
  markRead: 'auto',
  flag: 'auto',
  move: 'auto',
  archive: 'auto',
  notify: 'auto',
  session: 'auto',
  followup: 'auto',
  script: 'suggest',
  mcp: 'suggest',
  http: 'suggest',
}

/**
 * 把一条条件收成可信形状。
 *
 * 收窄放在这里而不是条件实现里：实现只该处理「形状已经对了」的情况，否则每个
 * 实现都要重复一遍同样的判断，而且判断标准会漂移。
 * @param input - 规则文件里的一条 `when` 元素。
 * @returns 条件，或 undefined（写歪了，由内核丢弃整条规则）。
 */
export function normalizeCondition(input: unknown): ConditionSpec | undefined {
  if (!isRecord(input)) return undefined
  const kind = named<ConditionKind>(input.kind, CONDITION_KINDS)
  // 简写形态 `- from: [...]`：一个单键对象，键就是条件名。
  if (kind === undefined) {
    const entries = Object.entries(input).filter(([key, value]) => value !== undefined && CONDITION_KINDS.has(key))
    if (entries.length !== 1) return undefined
    const [shorthand, value] = entries[0] as [string, unknown]
    const any = stringList(value)
    return any === undefined ? undefined : { kind: shorthand as ConditionKind, any }
  }
  const any = stringList(input.any)
  const name = clamped(input.name, MAX_NAME_LENGTH)
  const field = named<'from' | 'to' | 'subject' | 'body'>(input.field, new Set(['from', 'to', 'subject', 'body']))
  const pattern = clamped(input.pattern, MAX_PATTERN_LENGTH)
  const extensions = stringList(input.extensions, 32)
  const channel = named<'llm' | 'session'>(input.channel, new Set(['llm', 'session']))
  const labels = stringList(input.labels, 64)
  const prompt = clamped(input.prompt, MAX_INSTRUCTIONS_LENGTH)
  switch (kind) {
    case 'from':
    case 'to':
    case 'subject':
    case 'body':
      return any === undefined ? undefined : { kind, any }
    case 'header':
      // 头部名必须有；值可选（只判断「有没有这个头」也是合法用法）。
      return name === undefined ? undefined : { kind, name, ...(any === undefined ? {} : { any }) }
    case 'regex':
      return pattern === undefined || field === undefined ? undefined : { kind, pattern, field }
    case 'attachment':
      return {
        kind,
        ...(typeof input.has === 'boolean' ? { has: input.has } : {}),
        ...(extensions === undefined ? {} : { extensions }),
      }
    case 'classifier':
      return {
        kind,
        ...(channel === undefined ? {} : { channel }),
        ...(labels === undefined ? {} : { labels }),
        ...(prompt === undefined ? {} : { prompt }),
      }
  }
}

/**
 * 把一条动作收成可信形状。
 *
 * 每个 kind 只保留它自己用得上的字段：一个 `move` 带着 `agentPreset` 是作者写错
 * 了行，把无关字段一路带到执行层只会让「为什么这个动作没生效」更难查。
 * @param input - 规则文件里的一条 `then` 元素。
 * @returns 动作，或 undefined（写歪了，整条规则被丢弃）。
 */
export function normalizeAction(input: unknown): ActionSpec | undefined {
  if (!isRecord(input)) return undefined
  const kind = named<ActionKind>(input.kind, ACTION_KINDS)
  if (kind === undefined) return undefined
  const mode = named<ActionMode>(input.mode, ACTION_MODES)
  const delaySeconds = integer(input.delaySeconds, 0, MAX_UNDO_WINDOW_SECONDS)
  const folder = clamped(input.folder, MAX_NAME_LENGTH)
  const title = clamped(input.title, MAX_TITLE_LENGTH)
  const tone = named<'info' | 'success' | 'warn' | 'error'>(input.tone, TONES)
  const workspacePath = clamped(input.workspacePath, MAX_NAME_LENGTH)
  const workspaceTemplate = clamped(input.workspaceTemplate, MAX_NAME_LENGTH)
  const agentPreset = clamped(input.agentPreset, MAX_NAME_LENGTH)
  const permissionPreset = clamped(input.permissionPreset, MAX_NAME_LENGTH)
  const titleTemplate = clamped(input.titleTemplate, MAX_TITLE_LENGTH)
  const instructions = clamped(input.instructions, MAX_INSTRUCTIONS_LENGTH)
  const command = clamped(input.command, MAX_NAME_LENGTH)
  const args = stringList(input.args, MAX_MATCH_LENGTH)
  const cwd = clamped(input.cwd, MAX_NAME_LENGTH)
  const tool = clamped(input.tool, MAX_NAME_LENGTH)
  const url = clamped(input.url, MAX_PATTERN_LENGTH)
  const targetSession = clamped(input.sessionId, MAX_NAME_LENGTH)
  const method = named<'POST' | 'PUT'>(input.method, new Set(['POST', 'PUT']))
  const common = {
    kind,
    mode: mode ?? DEFAULT_MODE[kind],
    ...(delaySeconds === undefined ? {} : { delaySeconds }),
  }
  switch (kind) {
    case 'markRead':
    case 'flag':
      return common
    case 'move':
    case 'archive':
      // `archive` 允许不给 folder（用账号的 \Archive），`move` 必须给。
      if (kind === 'move' && folder === undefined) return undefined
      return { ...common, ...(folder === undefined ? {} : { folder }) }
    case 'notify':
      return { ...common, ...(title === undefined ? {} : { title }), ...(tone === undefined ? {} : { tone }) }
    case 'session': {
      // 至少要有一个工作目录来源，否则这个动作一定失败，不如现在就丢掉。
      if (workspacePath === undefined && workspaceTemplate === undefined) return undefined
      return {
        ...common,
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(workspaceTemplate === undefined ? {} : { workspaceTemplate }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(permissionPreset === undefined ? {} : { permissionPreset }),
        ...(titleTemplate === undefined ? {} : { titleTemplate }),
        ...(instructions === undefined ? {} : { instructions }),
      }
    }
    case 'followup':
      // 没有目标会话的投递一定失败，不如现在就丢掉。
      return targetSession === undefined ? undefined : {
        ...common,
        sessionId: targetSession,
        ...(instructions === undefined ? {} : { instructions }),
      }
    case 'script':
      return command === undefined ? undefined : {
        ...common,
        command,
        ...(args === undefined ? {} : { args }),
        ...(cwd === undefined ? {} : { cwd }),
      }
    case 'mcp':
      return tool === undefined ? undefined : {
        ...common,
        tool,
        ...(isRecord(input.input) ? { input: input.input } : {}),
      }
    case 'http':
      return url === undefined ? undefined : { ...common, url, ...(method === undefined ? {} : { method }) }
  }
}

/**
 * 预编译一遍正则条件。
 *
 * 放在加载期而不是运行期：一个写错的正则如果等到某封邮件真的到达才发现，用户
 * 得到的是「这封邮件没被处理」，而不是「你的第三条规则正则写错了」。宁可整份
 * 文件拒绝加载，也不要让一条规则静默失效。
 * @param rules - 已归一化的规则。
 * @returns 第一个不合法的正则，或 undefined。
 */
function validateRegexes(rules: readonly Rule[]): { readonly message: string } | undefined {
  for (const rule of rules) {
    for (const condition of rule.when) {
      if (condition.kind !== 'regex' || condition.pattern === undefined) continue
      try {
        new RegExp(condition.pattern, 'i')
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { message: `规则「${rule.name}」的正则写错了：${message}` }
      }
    }
  }
  return undefined
}

/** 邮件这一侧的词表：内核拿它把文件里的条目收成条件与动作。 */
export const MAIL_VOCABULARY: RuleVocabulary<ConditionSpec, ActionSpec> = {
  normalizeCondition,
  normalizeAction,
  validate: validateRegexes,
}

/**
 * 把一份规则数组收成可信、可用、有序的规则表。
 * @param input - YAML 解析出来的顶层值。
 * @returns 排好序的规则与被丢弃的条目。
 */
export function normalizeRules(input: unknown): { readonly rules: readonly Rule[]; readonly dropped: readonly string[] } {
  return normalizeRuleList(input, MAIL_VOCABULARY)
}

/** 发货默认的仓库根目录；发货规则里的 `{repoRoot}` 就是它。 */
export const DEFAULT_REPO_ROOT = 'D:/open'

/**
 * Loader 行的默认配置。
 *
 * 显式写出来而不是只靠 `normalizeConfig` 里的 `??`：文档与 profile 示例要有一份能
 * 抄的默认值，两份默认值一旦漂移就很难查。
 */
export const DEFAULT_CONFIG: Config = {
  ...DEFAULT_DECISION_CONFIG,
  repoRoot: DEFAULT_REPO_ROOT,
}

/**
 * 读 Loader 行配置。
 *
 * 坏字段退回默认值而不是报错：这一行是用户手写的 YAML，写错一个数字该少一点
 * 功能，不该让插件起不来（与 `packages/mail/src/config.ts` 同一取舍）。
 * @param input - Loader 行给的配置。
 * @returns 五个判定层字段 + 这个插件自己的 `repoRoot`。
 */
export function normalizeConfig(input: unknown): Config {
  const source = isRecord(input) ? input : {}
  return {
    ...normalizeDecisionConfig(source),
    repoRoot: clamped(source.repoRoot, MAX_NAME_LENGTH) ?? DEFAULT_REPO_ROOT,
  }
}

export {
  DEFAULT_RUN_HISTORY_LIMIT, DEFAULT_RUN_RETENTION_DAYS, DEFAULT_UNDO_WINDOW_SECONDS,
}
