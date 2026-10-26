/**
 * 默认值，以及不可信输入变成可信形状的唯一入口。
 *
 * 规则文件的作者可能是人，也可能是 agent，所以每个字段都当作 `unknown` 看待，
 * 直到经过这里：一个 `mode: auto` 写成 `mode: yes` 的动作、一个 `priority` 写成
 * 字符串的规则、一条把 `when` 写成对象而不是数组的规则——结果要么是合法值，要么
 * 是一条被丢弃的条目与一句日志。
 *
 * **丢弃而不整体失败**是刻意的：一份 20 条的规则文件里有一条写歪，用户要的是
 * 另外 19 条继续工作，而不是整个分诊停摆。整体失败只留给 YAML 本身解析不了
 * （那时连「另外 19 条」都读不出来），见 `src/rules.ts`。
 *
 * @module @free-lzj/dsh-mail/triage/config
 */

import {
  DEFAULT_RUN_HISTORY_LIMIT,
  DEFAULT_RUN_RETENTION_DAYS,
  DEFAULT_UNDO_WINDOW_SECONDS,
  type ActionKind,
  type ActionMode,
  type ActionSpec,
  type ConditionKind,
  type ConditionSpec,
  type Config,
  type Rule,
} from './types.ts'

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

/** 各字段的长度上限：这些都是一行字或一段约束，不是正文。 */
const MAX_NAME_LENGTH = 120
const MAX_MATCH_LENGTH = 400
const MAX_PATTERN_LENGTH = 1000
const MAX_INSTRUCTIONS_LENGTH = 4000
const MAX_TITLE_LENGTH = 200

/** 三个数字的合法区间。 */
const MAX_UNDO_WINDOW_SECONDS = 24 * 60 * 60
const MAX_RUN_HISTORY_LIMIT = 100_000
const MAX_RUN_RETENTION_DAYS = 3650

/** Whether a value is a JSON object rather than an array, `null` or a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty, trimmed string, or undefined for anything else. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A non-empty trimmed string cut to `limit`, or undefined. */
function clamped(value: unknown, limit: number): string | undefined {
  const kept = text(value)
  return kept === undefined ? undefined : kept.slice(0, limit)
}

/** A member of a fixed set of names, or undefined. */
function named<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined
}

/** An integer in `min`–`max`, accepting the text a number input sends. */
function integer(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : undefined
}

/** A list of non-empty trimmed strings; absent when nothing is left. */
function stringList(value: unknown, limit = MAX_MATCH_LENGTH): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    const single = clamped(value, limit)
    return single === undefined ? undefined : [single]
  }
  const kept = value.flatMap((item) => {
    const one = clamped(item, limit)
    return one === undefined ? [] : [one]
  })
  return kept.length === 0 ? undefined : kept
}

/**
 * 把一条条件收成可信形状。
 *
 * 收窄放在这里而不是条件实现里：实现只该处理「形状已经对了」的情况，否则每个
 * 实现都要重复一遍同样的判断，而且判断标准会漂移。
 * @param input - 规则文件里的一条 `when` 元素。
 * @returns 条件，或 undefined（写歪了，由 `normalizeRule` 丢弃整条规则）。
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
 * 由规则名派生一个稳定的 id。
 *
 * 中文名派生出来会只剩连字符，所以退化成 `rule-<位置>`：id 的作用是「在同一次
 * 会话里定位这一条」，不是好看。
 * @param name - 规则名。
 * @param index - 它在文件里的位置，用于兜底。
 * @returns 一个能进 URL 的 id。
 */
function deriveId(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug === '' ? `rule-${String(index + 1)}` : slug
}

/** 一次归一化的结果：可用的规则，以及被丢弃的原因（给日志）。 */
export interface NormalizedRules {
  readonly rules: readonly Rule[]
  /** 每条被丢弃的条目一句话，包含它在文件里的位置。 */
  readonly dropped: readonly string[]
}

/**
 * 把一份规则数组收成可信、可用、有序的规则表。
 *
 * `priority` 缺省按数组下标 × 10：文件的书写顺序就是优先级顺序，这是人唯一能
 * 从文件里直接读出来的顺序预期。
 * @param input - YAML 解析出来的顶层值。
 * @returns 排好序的规则与被丢弃的条目。
 */
export function normalizeRules(input: unknown): NormalizedRules {
  const dropped: string[] = []
  if (!Array.isArray(input)) {
    return { rules: [], dropped: ['规则文件的顶层必须是一个数组（每条规则一个元素）'] }
  }
  const rules: Rule[] = []
  const usedIds = new Set<string>()
  input.forEach((item, index) => {
    const where = `第 ${String(index + 1)} 条`
    if (!isRecord(item)) {
      dropped.push(`${where}：不是一个对象`)
      return
    }
    const name = clamped(item.name, MAX_NAME_LENGTH)
    if (name === undefined) {
      dropped.push(`${where}：缺少 name`)
      return
    }
    if (!Array.isArray(item.when)) {
      dropped.push(`${where}（${name}）：when 必须是数组（空数组表示匹配一切）`)
      return
    }
    const when = item.when.map(normalizeCondition)
    if (when.some(condition => condition === undefined)) {
      dropped.push(`${where}（${name}）：when 里有写歪的条件，整条规则已跳过`)
      return
    }
    if (!Array.isArray(item.then)) {
      dropped.push(`${where}（${name}）：then 必须是数组`)
      return
    }
    const then = item.then.map(normalizeAction)
    if (then.some(action => action === undefined)) {
      dropped.push(`${where}（${name}）：then 里有写歪的动作，整条规则已跳过`)
      return
    }
    // 一个动作都不做的规则没有意义：它只会占位并挡住后面的规则。
    if (then.length === 0) {
      dropped.push(`${where}（${name}）：then 是空的，没有任何动作`)
      return
    }
    let id = clamped(item.id, MAX_NAME_LENGTH) ?? deriveId(name, index)
    if (usedIds.has(id)) {
      dropped.push(`${where}（${name}）：id "${id}" 与前面重复，已改用位置派生`)
      id = `${id}-${String(index + 1)}`
    }
    usedIds.add(id)
    const label = clamped(item.label, MAX_NAME_LENGTH)
    rules.push({
      id,
      name,
      enabled: item.enabled === undefined ? true : item.enabled === true,
      priority: integer(item.priority, 0, 1_000_000) ?? index * 10,
      when: when as readonly ConditionSpec[],
      ...(label === undefined ? {} : { label }),
      then: then as readonly ActionSpec[],
      ...(typeof item.stopOnMatch === 'boolean' ? { stopOnMatch: item.stopOnMatch } : {}),
    })
  })
  rules.sort((left, right) => left.priority - right.priority)
  return { rules, dropped }
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
  enabled: true,
  dryRun: false,
  undoWindowSeconds: DEFAULT_UNDO_WINDOW_SECONDS,
  runHistoryLimit: DEFAULT_RUN_HISTORY_LIMIT,
  runRetentionDays: DEFAULT_RUN_RETENTION_DAYS,
  repoRoot: DEFAULT_REPO_ROOT,
}

/**
 * 读 Loader 行配置。
 *
 * 坏字段退回默认值而不是报错：这一行是用户手写的 YAML，写错一个数字该少一点
 * 功能，不该让插件起不来（与 `packages/mail/src/config.ts` 同一取舍）。
 * @param input - Loader 行给的配置。
 * @returns 三个数都在合法区间里的配置。
 */
export function normalizeConfig(input: unknown): Config {
  const source = isRecord(input) ? input : {}
  return {
    // `enabled` 缺省为真：装了插件却什么都不做，是更难查的「坏掉」。
    enabled: source.enabled === undefined ? true : source.enabled === true,
    dryRun: source.dryRun === true,
    undoWindowSeconds: integer(source.undoWindowSeconds, 0, MAX_UNDO_WINDOW_SECONDS) ?? DEFAULT_UNDO_WINDOW_SECONDS,
    runHistoryLimit: integer(source.runHistoryLimit, 1, MAX_RUN_HISTORY_LIMIT) ?? DEFAULT_RUN_HISTORY_LIMIT,
    runRetentionDays: integer(source.runRetentionDays, 1, MAX_RUN_RETENTION_DAYS) ?? DEFAULT_RUN_RETENTION_DAYS,
    repoRoot: clamped(source.repoRoot, MAX_NAME_LENGTH) ?? DEFAULT_REPO_ROOT,
  }
}
