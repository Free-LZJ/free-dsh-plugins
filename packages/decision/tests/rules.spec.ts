/**
 * 规则文件：版本、语法错误、两种顶层形态，以及**注释不能被写操作抹掉**。
 *
 * 最后一条是这个模块最容易被改坏的地方：一次「把对象解析出来再序列化」的重构就能
 * 让用户的注释消失，而页面看起来一切正常。所以每条写操作都断言注释还在。
 *
 * @module @free-lzj/dsh-decision/tests/rules
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseRuleFile, loadRuleFile, setActionMode, setConditionValues, setRuleEnabled, swapPriority, RULES_VERSION,
} from '../src/rules.ts'
import type { RuleVocabulary } from '../src/config.ts'
import type { Rule } from '../src/types.ts'

/** 条件/动作的假形状：`kind` 就够。 */
interface Spec {
  readonly kind: string
  readonly pattern?: string
  readonly mode?: string
}

/** 只认 `kind` 的假词表。 */
const vocabulary: RuleVocabulary<Spec, Spec> = {
  normalizeCondition: (input) => {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as { kind?: unknown; pattern?: unknown }
    if (typeof record.kind !== 'string') return undefined
    return { kind: record.kind, ...(typeof record.pattern === 'string' ? { pattern: record.pattern } : {}) }
  },
  normalizeAction: (input) => {
    if (typeof input !== 'object' || input === null) return undefined
    const record = input as { kind?: unknown; mode?: unknown }
    if (typeof record.kind !== 'string') return undefined
    return { kind: record.kind, ...(typeof record.mode === 'string' ? { mode: record.mode } : {}) }
  },
}

/** 一份带注释的文件：写操作之后注释必须还在。 */
const SOURCE = `# 顶部说明：这条注释是给人看的
rules:
  # 第一条：GitHub 通知
  - id: github
    name: GitHub 通知
    enabled: true
    priority: 10
    when:
      - kind: from
        any: [github]
    then:
      - kind: archive
      # 动作上的注释
      - kind: notify
        mode: auto
  - id: promo
    name: 推广
    priority: 20
    when:
      - kind: subject
        any: [促销]
    then:
      - kind: archive
`

/** 规则数组，供 swapPriority 比较。 */
function rules(): readonly Rule<Spec, Spec>[] {
  return [
    { id: 'github', name: 'GitHub 通知', enabled: true, priority: 10, when: [], then: [{ kind: 'archive' }] },
    { id: 'promo', name: '推广', enabled: true, priority: 20, when: [], then: [{ kind: 'archive' }] },
  ]
}

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('parseRuleFile', () => {
  it('reads a bare array and an object with version and rules alike', () => {
    const bare = parseRuleFile('- name: A\n  when: []\n  then: [{ kind: archive }]\n', vocabulary)
    const wrapped = parseRuleFile(`version: ${String(RULES_VERSION)}\nrules:\n  - name: A\n    when: []\n    then: [{ kind: archive }]\n`, vocabulary)
    expect(bare.ok && bare.rules.map(rule => rule.name)).toEqual(['A'])
    expect(wrapped.ok && wrapped.rules.map(rule => rule.name)).toEqual(['A'])
  })

  it('refuses a version it does not know instead of guessing half the file', () => {
    const parsed = parseRuleFile('version: 2\nrules: []\n', vocabulary)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.message).toContain('不认识的规则文件版本')
  })

  it('points at the line when the YAML itself is broken', () => {
    const parsed = parseRuleFile('rules:\n  - name: [unclosed\n', vocabulary)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(typeof parsed.error.line).toBe('number')
  })

  it('runs the vocabulary validator over the parsed rules', () => {
    const parsed = parseRuleFile(
      '- name: A\n  when: [{ kind: regex, pattern: "(" }]\n  then: [{ kind: archive }]\n',
      {
        ...vocabulary,
        validate: (parsedRules) => (parsedRules[0]?.when[0]?.pattern === '(' ? { message: '正则写错了' } : undefined),
      },
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.message).toBe('正则写错了')
  })
})

describe('loadRuleFile', () => {
  it('writes the shipped default out when there is no file yet, and says so', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-decision-rules-'))
    paths.push(home)
    const path = join(home, 'rules.yml')
    const loaded = await loadRuleFile(path, '- name: 默认\n  when: []\n  then: [{ kind: archive }]\n', vocabulary)
    expect(loaded.source).toBe('default')
    expect(loaded.rules.map(rule => rule.name)).toEqual(['默认'])
    expect(await readFile(path, 'utf8')).toContain('默认')
  })

  it('answers an error and no rules when the shipped default is itself broken', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-decision-rules-'))
    paths.push(home)
    const loaded = await loadRuleFile(join(home, 'rules.yml'), 'rules: [', vocabulary)
    expect(loaded.rules).toEqual([])
    expect(loaded.source).toBe('default')
    expect(loaded.error?.message).toContain('内置默认规则无法解析')
  })
})

describe('setConditionValues', () => {
  it('rewrites a standard condition list and keeps every comment', () => {
    const result = setConditionValues(SOURCE, 'github', 0, ['gitlab', 'bitbucket'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('gitlab')
    expect(result.text).not.toContain('any: [github]')
    // 写操作不能吃掉注释——这是这个模块最容易改坏的地方。
    expect(result.text).toContain('# 顶部说明')
    expect(result.text).toContain('# 第一条：GitHub 通知')
    expect(result.text).toContain('# 动作上的注释')
  })

  it('rewrites the shorthand form as well', () => {
    const shorthand = ['- id: jira', '  when:', '    - from: [a@b.com]', '  then:', '    - kind: notify'].join('\n')
    const result = setConditionValues(shorthand, 'jira', 0, ['x@y.com'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('x@y.com')
    expect(result.text).not.toContain('a@b.com')
  })

  it('refuses an index the rule does not have', () => {
    expect(setConditionValues(SOURCE, 'github', 3, ['x'])).toEqual({ ok: false, error: '规则 github 没有第 4 个条件' })
  })

  it('refuses an id the file does not have', () => {
    expect(setConditionValues(SOURCE, 'nope', 0, ['x'])).toEqual({ ok: false, error: '找不到规则 nope' })
  })
})
describe('targeted edits keep the file readable', () => {
  /** 改完之后再读一遍：写操作唯一可信的验收是「文件仍然是一份规则文件」。 */
  function reread(text: string): readonly Rule<Spec, Spec>[] {
    const parsed = parseRuleFile(text, vocabulary)
    if (!parsed.ok) throw new Error(`改完之后解析失败：${parsed.error.message}`)
    return parsed.rules
  }

  it('toggles one rule without touching the comments', () => {
    const result = setRuleEnabled(SOURCE, 'github', false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('# 顶部说明：这条注释是给人看的')
    expect(result.text).toContain('# 第一条：GitHub 通知')
    expect(result.text).toContain('# 动作上的注释')
    // 关键：wrapped 形态（`version` + `rules`）下改的必须真的是那条规则，
    // 而不是往文档里塞一个 `0:` 键。
    expect(reread(result.text).find(rule => rule.id === 'github')?.enabled).toBe(false)
    expect(result.text).not.toMatch(/^0:/m)
  })

  it('refuses to toggle a rule that is not in the file', () => {
    const result = setRuleEnabled(SOURCE, 'missing', false)
    expect(result).toEqual({ ok: false, error: '找不到规则 missing' })
  })

  it('changes one action\u2019s mode by its position', () => {
    const result = setActionMode(SOURCE, 'github', 1, 'suggest')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(reread(result.text).find(rule => rule.id === 'github')?.then[1]?.mode).toBe('suggest')
    expect(result.text).toContain('# 动作上的注释')
  })

  it('refuses an action index the rule does not have', () => {
    const result = setActionMode(SOURCE, 'github', 9, 'auto')
    expect(result).toEqual({ ok: false, error: '规则 github 没有第 10 个动作' })
  })

  it('swaps priority with the neighbour rather than reordering the file', () => {
    const result = swapPriority(SOURCE, 'github', rules(), 'down')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = reread(result.text)
    expect(after.find(rule => rule.id === 'github')?.priority).toBe(20)
    expect(after.find(rule => rule.id === 'promo')?.priority).toBe(10)
    // 文件里的书写顺序没变：github 仍然在上面。
    expect(result.text.indexOf('id: github')).toBeLessThan(result.text.indexOf('id: promo'))
  })

  it('refuses to move the first rule up', () => {
    expect(swapPriority(SOURCE, 'github', rules(), 'up')).toEqual({ ok: false, error: '已经在最前面' })
  })

  it('refuses to edit a file it cannot parse', () => {
    const result = setRuleEnabled('rules: [', 'github', false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('规则文件无法解析')
  })
})
