/**
 * 规则文件：读、写、以及「只改一行」。
 *
 * 规则存成一个 YAML 文件而不是插件状态，是因为这份配置的主要作者是 **agent**：
 * 它能读、能 diff、能进 git、能被人一眼看懂；而表单编辑器装不下「一条规则里
 * 三个带参数的动作」这种结构。代价是必须保证**被人和 agent 写进去的注释不会
 * 被程序抹掉**——所以下面所有写操作都走 `parseDocument` 的定向修改，绝不
 * `parse` 之后再 `stringify`（那会把整份文件的注释与顺序重排）。
 *
 * 两种失败要分开：YAML **解析不了**是整体失败（连有几条规则都读不出来），
 * 而单条规则写歪是局部失败（由 `src/config.ts` 丢弃那一条）。这里只处理前者。
 *
 * @module @free-lzj/dsh-mail/triage/rules
 */

import { readFile } from 'node:fs/promises'
import { parseDocument, YAMLParseError, type Document } from 'yaml'
import { normalizeRules, isRecord } from './config.ts'
import { writeTextFile } from './store.ts'
import type { ActionMode, Rule, RuleFileError } from './types.ts'

/** 规则文件里认识的版本号；不认识的版本拒绝加载而不是猜。 */
export const RULES_VERSION = 1

/** 一次读取的结果。 */
export interface LoadedRules {
  readonly rules: readonly Rule[]
  /** 解析失败时的结构化错误；此时 `rules` 是调用方该保留的上一份。 */
  readonly error?: RuleFileError
  /** 规则是从文件来的还是从发货默认值来的。 */
  readonly source: 'file' | 'default'
  /** 被丢弃的条目说明（写歪的规则），进日志用。 */
  readonly dropped: readonly string[]
}

/**
 * 把一份规则文件的文本解析成规则。
 *
 * 版本号不认识时**整体拒绝**：一个 `version: 2` 的文件可能用着这一版读不懂的
 * 字段，按 v1 去读会静默丢掉半份配置——那种「看起来生效了但少了三条规则」比
 * 直接报错难查得多。
 * @param source - 文件全文。
 * @returns 解析结果；失败时 `error.line` 有值就能指到行。
 */
export function parseRules(source: string): { ok: true; rules: readonly Rule[]; dropped: readonly string[] } | { ok: false; error: RuleFileError } {
  let document: Document
  try {
    document = parseDocument(source)
  } catch (error: unknown) {
    return { ok: false, error: yamlError(error) }
  }
  // `parseDocument` 把语法错误收在 errors 里而不是抛出。
  if (document.errors.length > 0) {
    const first = document.errors[0] as YAMLParseError
    return { ok: false, error: { message: first.message, ...lineOf(first) } }
  }
  const value = document.toJS() as unknown
  // 顶层可以是裸数组（最常见的写法），也可以是带 version 的对象。
  const root = Array.isArray(value) ? { version: RULES_VERSION, rules: value } : value
  if (!isRecord(root)) {
    return { ok: false, error: { message: '规则文件的顶层必须是一个数组，或一个带 version 与 rules 的对象' } }
  }
  if (root['version'] !== undefined && root['version'] !== RULES_VERSION) {
    return {
      ok: false,
      error: { message: `不认识的规则文件版本 ${JSON.stringify(root['version'])}；本版只认 ${String(RULES_VERSION)}` },
    }
  }
  const normalized = normalizeRules(root['rules'] ?? [])
  const invalid = invalidRegex(normalized.rules)
  if (invalid !== undefined) return { ok: false, error: invalid }
  return { ok: true, rules: normalized.rules, dropped: normalized.dropped }
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
function invalidRegex(rules: readonly Rule[]): RuleFileError | undefined {
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

/** 从 yaml 的错误里取出行号（1 基，页面直接用）。 */
function lineOf(error: YAMLParseError): { line?: number } {
  const line = error.linePos?.[0]?.line
  return line === undefined ? {} : { line }
}

/** 把任意抛出物转成结构化错误。 */
function yamlError(error: unknown): RuleFileError {
  if (error instanceof YAMLParseError) return { message: error.message, ...lineOf(error) }
  return { message: error instanceof Error ? error.message : String(error) }
}

/**
 * 读规则文件；不存在就用发货的默认规则并**把它写出去**。
 *
 * 写出去这一步是刻意的：规则藏在包里，用户就永远不知道自己可以改；写到
 * `$DSH_HOME` 下，他能看见、能改、agent 也能改。
 * @param path - 用户的规则文件路径。
 * @param fallback - 规则文件不存在时用的发货默认内容。
 * @returns 加载结果；`error` 有值时调用方应保留上一份规则而不是用默认值顶上。
 */
export async function loadRules(path: string, fallback: string): Promise<LoadedRules> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // 文件不存在（或读不了）：用默认规则，并落一份到磁盘供人修改。
    const parsed = parseRules(fallback)
    if (!parsed.ok) {
      // 发货内容自己坏了，是打包事故而不是用户配置错误，必须显式暴露。
      return { rules: [], error: { message: `内置默认规则无法解析：${parsed.error.message}` }, source: 'default', dropped: [] }
    }
    try {
      await writeTextFile(path, fallback)
    } catch {
      // 写不出去（只读挂载等）不影响本次生效，下一次启动再试。
    }
    return { rules: parsed.rules, source: 'default', dropped: parsed.dropped }
  }
  const parsed = parseRules(raw)
  if (!parsed.ok) return { rules: [], error: parsed.error, source: 'file', dropped: [] }
  return { rules: parsed.rules, source: 'file', dropped: parsed.dropped }
}

/* ─────────────────────────── 定向修改（保留注释） ─────────────────────────── */

/** 一次编辑的结果：新文本，或一条说明。 */
export type EditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }

/**
 * 找到某条规则在规则数组里的下标。
 *
 * 顶层形态有两种（裸数组，或带 `rules` 的对象），所以下标从 `document.contents`
 * 或 `document.getIn(['rules'])` 里取——`src/config.ts` 接受两种写法，读回来时
 * 也必须认得两种。
 */
function indexOfRule(document: Document, id: string): number | undefined {
  const sequence = document.getIn(['rules'], true) ?? document.contents
  const items = (sequence as { items?: readonly unknown[] } | null)?.items
  if (items === undefined) return undefined
  for (const [index, item] of items.entries()) {
    // `toJS` 需要所属文档（它要解析锚点与自定义标签），不能空调用。
    const node = item as { toJS?: (document: Document) => unknown }
    const value = typeof node.toJS === 'function' ? node.toJS(document) : item
    if (isRecord(value) && value['id'] === id) return index
  }
  return undefined
}

/**
 * 就地改一个字段并交回新文本。
 *
 * 走 `parseDocument` 而不是「解析成对象再序列化」：后者会把用户和 agent 写下的
 * 注释、空行、键顺序全部丢掉，而这份文件是给人读的。
 * @param source - 当前文件全文。
 * @param mutate - 拿到文档后做的修改。
 * @returns 新文本，或失败原因。
 */
function editDocument(source: string, mutate: (document: Document) => string | undefined): EditResult {
  let document: Document
  try {
    document = parseDocument(source)
  } catch (error: unknown) {
    return { ok: false, error: `规则文件无法解析：${yamlError(error).message}` }
  }
  if (document.errors.length > 0) {
    return { ok: false, error: `规则文件无法解析：${document.errors[0]?.message ?? '未知语法错误'}` }
  }
  const refused = mutate(document)
  if (refused !== undefined) return { ok: false, error: refused }
  return { ok: true, text: document.toString() }
}

/**
 * 规则数组在文档里的路径：顶层是序列时是 `[]`，是映射时是 `['rules']`。
 *
 * 判据是节点身上有没有 `items`（YAMLSeq），而**不是** `Array.isArray`——文档里装的
 * 是 YAML 节点，不是 JS 数组。
 */
function arrayPath(document: Document): readonly (string | number)[] {
  const contents = document.contents as { items?: unknown } | null
  return contents !== null && contents.items !== undefined ? [] : ['rules']
}

/**
 * 开关一条规则。
 * @param source - 当前文件全文。
 * @param id - 规则 id。
 * @param enabled - 目标状态。
 * @returns 新文本，或失败原因。
 */
export function setRuleEnabled(source: string, id: string, enabled: boolean): EditResult {
  return editDocument(source, (document) => {
    const index = indexOfRule(document, id)
    if (index === undefined) return `找不到规则 ${id}`
    document.setIn([...arrayPath(document), index, 'enabled'], enabled)
    return undefined
  })
}

/**
 * 改一条规则里某个动作的三态。
 * @param source - 当前文件全文。
 * @param id - 规则 id。
 * @param actionIndex - 动作在 `then` 里的下标。
 * @param mode - 目标三态。
 * @returns 新文本，或失败原因。
 */
export function setActionMode(source: string, id: string, actionIndex: number, mode: ActionMode): EditResult {
  return editDocument(source, (document) => {
    const index = indexOfRule(document, id)
    if (index === undefined) return `找不到规则 ${id}`
    const then = document.getIn([...arrayPath(document), index, 'then'], true)
    const items = (then as { items?: readonly unknown[] } | undefined)?.items
    if (items === undefined || actionIndex < 0 || actionIndex >= items.length) {
      return `规则 ${id} 没有第 ${String(actionIndex + 1)} 个动作`
    }
    document.setIn([...arrayPath(document), index, 'then', actionIndex, 'mode'], mode)
    return undefined
  })
}

/**
 * 把一条规则往上或往下挪一位。
 *
 * 交换的是 `priority` 值而不是数组里的位置：数组位置是文件的书写顺序，改它等于
 * 重排用户的文件；而 `priority` 正是匹配用的那个数，改它语义准确、diff 也最小。
 * @param source - 当前文件全文。
 * @param id - 规则 id。
 * @param parsed - 当前已生效的规则（用来找相邻的那条）。
 * @param direction - 往上还是往下。
 * @returns 新文本，或失败原因。
 */
export function swapPriority(source: string, id: string, parsed: readonly Rule[], direction: 'up' | 'down'): EditResult {
  const ordered = [...parsed].sort((left, right) => left.priority - right.priority)
  const position = ordered.findIndex(rule => rule.id === id)
  if (position === -1) return { ok: false, error: `找不到规则 ${id}` }
  const neighbour = ordered[direction === 'up' ? position - 1 : position + 1]
  if (neighbour === undefined) return { ok: false, error: direction === 'up' ? '已经在最前面' : '已经在最后面' }
  const self = ordered[position] as Rule
  return editDocument(source, (document) => {
    const selfIndex = indexOfRule(document, self.id)
    const neighbourIndex = indexOfRule(document, neighbour.id)
    if (selfIndex === undefined || neighbourIndex === undefined) return '规则文件与当前生效的规则不一致，请先修复文件'
    const path = arrayPath(document)
    document.setIn([...path, selfIndex, 'priority'], neighbour.priority)
    document.setIn([...path, neighbourIndex, 'priority'], self.priority)
    return undefined
  })
}
