/**
 * 默认值，以及不可信输入变成可信形状的唯一入口。
 *
 * 内核这一层只管**结构**：顶层是不是数组、`name` 有没有、`when`/`then` 是不是数组、
 * 有没有一条规则重复用了别人的 id、`priority` 是不是整数。至于「`from` 条件该带
 * 什么字段」「`move` 动作必须有文件夹」——那是连接器的词表，由它注入的
 * {@link RuleVocabulary} 决定。
 *
 * **丢弃而不整体失败**是刻意的：一份 20 条的文件里有一条写歪，用户要的是另外 19 条
 * 继续工作，而不是整个判定停摆。整体失败只留给 YAML 本身解析不了（那时连「另外
 * 19 条」都读不出来），见 `rules.ts`。
 *
 * @module @free-lzj/dsh-decision/config
 */

import type { Rule } from './types.ts'

/** 撤销窗口的默认秒数。 */
export const DEFAULT_UNDO_WINDOW_SECONDS = 120
/** 命中记录默认保留多少条。 */
export const DEFAULT_RUN_HISTORY_LIMIT = 500
/** 命中记录默认保留多少天。 */
export const DEFAULT_RUN_RETENTION_DAYS = 30

/** 三个数字的合法区间。 */
export const MAX_UNDO_WINDOW_SECONDS = 24 * 60 * 60
export const MAX_RUN_HISTORY_LIMIT = 100_000
export const MAX_RUN_RETENTION_DAYS = 3650

/** 各字段的长度上限：这些都是一行字或一段约束，不是正文。 */
export const MAX_NAME_LENGTH = 120
export const MAX_MATCH_LENGTH = 400
export const MAX_PATTERN_LENGTH = 1000
export const MAX_INSTRUCTIONS_LENGTH = 4000
export const MAX_TITLE_LENGTH = 200

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
export function clamped(value: unknown, limit: number): string | undefined {
  const kept = text(value)
  return kept === undefined ? undefined : kept.slice(0, limit)
}

/** A member of a fixed set of names, or undefined. */
export function named<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined
}

/** An integer in `min`–`max`, accepting the text a number input sends. */
export function integer(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : undefined
}

/** A list of non-empty trimmed strings; absent when nothing is left. */
export function stringList(value: unknown, limit = MAX_MATCH_LENGTH): readonly string[] | undefined {
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
 * 规则文件里那条「把不可信输入变可信」的词表。
 *
 * 每一条条件/动作的字段校验都在连接器那边；内核只要求两件事：认不出就返回
 * undefined（那一条规则会被丢弃并记一句），以及别抛。
 */
export interface RuleVocabulary<TCondition, TAction> {
  /**
   * 把一条 `when` 元素收成可信形状。
   * @param input - 规则文件里的原始值。
   * @returns 条件，或 undefined（写歪了）。
   */
  normalizeCondition(input: unknown): TCondition | undefined
  /**
   * 把一条 `then` 元素收成可信形状。
   * @param input - 规则文件里的原始值。
   * @returns 动作，或 undefined（写歪了）。
   */
  normalizeAction(input: unknown): TAction | undefined
  /**
   * 整份文件级的额外校验（例如预编译所有正则）。
   * @param rules - 已归一化的规则。
   * @returns 第一个问题，或 undefined。
   */
  validate?(rules: readonly Rule<TCondition, TAction>[]): { readonly message: string; readonly line?: number } | undefined
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
export interface NormalizedRules<TCondition, TAction> {
  readonly rules: readonly Rule<TCondition, TAction>[]
  /** 每条被丢弃的条目一句话，包含它在文件里的位置。 */
  readonly dropped: readonly string[]
}

/**
 * 把一份规则数组收成可信、可用、有序的规则表。
 *
 * `priority` 缺省按数组下标 × 10：文件的书写顺序就是优先级顺序，这是人唯一能
 * 从文件里直接读出来的顺序预期。
 * @param input - YAML 解析出来的顶层值。
 * @param vocabulary - 连接器的词表：条件与动作怎么收窄。
 * @returns 排好序的规则与被丢弃的条目。
 */
export function normalizeRules<TCondition, TAction>(
  input: unknown,
  vocabulary: RuleVocabulary<TCondition, TAction>,
): NormalizedRules<TCondition, TAction> {
  const dropped: string[] = []
  if (!Array.isArray(input)) {
    return { rules: [], dropped: ['规则文件的顶层必须是一个数组（每条规则一个元素）'] }
  }
  const rules: Rule<TCondition, TAction>[] = []
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
    const when = item.when.map(entry => vocabulary.normalizeCondition(entry))
    if (when.some(condition => condition === undefined)) {
      dropped.push(`${where}（${name}）：when 里有写歪的条件，整条规则已跳过`)
      return
    }
    if (!Array.isArray(item.then)) {
      dropped.push(`${where}（${name}）：then 必须是数组`)
      return
    }
    const then = item.then.map(entry => vocabulary.normalizeAction(entry))
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
      when: when as readonly TCondition[],
      ...(label === undefined ? {} : { label }),
      then: then as readonly TAction[],
      ...(typeof item.stopOnMatch === 'boolean' ? { stopOnMatch: item.stopOnMatch } : {}),
    })
  })
  rules.sort((left, right) => left.priority - right.priority)
  return { rules, dropped }
}

/**
 * 判定层与来源无关的那几个开关。
 *
 * 连接器可以在这之上加自己的字段（邮件的 `repoRoot`），做法是自己读一遍入参再
 * 合进来——内核的函数返回的仍是这个形状。
 */
export interface DecisionConfigBase {
  /** 总开关：关掉之后新事件不再交给规则。 */
  readonly enabled: boolean
  /** 只记录不动作，用来在真开之前观察一轮。 */
  readonly dryRun: boolean
  /** 有副作用动作的撤销窗口；`0` = 立即执行。 */
  readonly undoWindowSeconds: number
  /** 命中记录最多保留多少条。 */
  readonly runHistoryLimit: number
  /** 命中记录保留天数（先按天数、再按条数裁）。 */
  readonly runRetentionDays: number
}

/** 判定层的默认配置。 */
export const DEFAULT_DECISION_CONFIG: DecisionConfigBase = {
  enabled: true,
  dryRun: false,
  undoWindowSeconds: DEFAULT_UNDO_WINDOW_SECONDS,
  runHistoryLimit: DEFAULT_RUN_HISTORY_LIMIT,
  runRetentionDays: DEFAULT_RUN_RETENTION_DAYS,
}

/**
 * 读一份判定配置。
 *
 * 坏字段退回默认值而不是报错：这一行是用户手写的 YAML，写错一个数字该少一点
 * 功能，不该让插件起不来。
 * @param input - Loader 行给的配置。
 * @returns 五个值都在合法区间里的配置。
 */
export function normalizeDecisionConfig(input: unknown): DecisionConfigBase {
  const source = isRecord(input) ? input : {}
  return {
    // `enabled` 缺省为真：装了插件却什么都不做，是更难查的「坏掉」。
    enabled: source.enabled === undefined ? true : source.enabled === true,
    dryRun: source.dryRun === true,
    undoWindowSeconds: integer(source.undoWindowSeconds, 0, MAX_UNDO_WINDOW_SECONDS) ?? DEFAULT_UNDO_WINDOW_SECONDS,
    runHistoryLimit: integer(source.runHistoryLimit, 1, MAX_RUN_HISTORY_LIMIT) ?? DEFAULT_RUN_HISTORY_LIMIT,
    runRetentionDays: integer(source.runRetentionDays, 1, MAX_RUN_RETENTION_DAYS) ?? DEFAULT_RUN_RETENTION_DAYS,
  }
}
