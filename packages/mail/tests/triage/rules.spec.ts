/**
 * 规则文件的读与「只改一行」。
 *
 * 这份文件的主要作者是 **agent**，而人会往里写注释解释「为什么这样配」——所以最重要
 * 的一组用例是：定向修改之后**注释还在**。用「解析成对象再序列化」的实现会在这里红。
 *
 * @module @free-lzj/dsh-mail/tests/triage/rules
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseRules, setActionMode, setRuleEnabled, swapPriority } from '../../src/triage/rules.ts'
import { normalizeConfig, normalizeRules } from '../../src/triage/config.ts'

/** 一份带注释、带自定义顺序的规则文件。 */
const SOURCE = `# 顶部的说明：为什么这么配
- id: github
  name: GitHub 通知        # 行尾注释也要留住
  priority: 10
  when:
    - kind: from
      any:
        - notifications@github.com
  then:
    - kind: session
      workspaceTemplate: '{repoRoot}/{repo}'
      agentPreset: mail-github-worker
    - kind: notify

- id: promo
  name: 推广
  priority: 20
  when:
    - kind: header
      name: list-unsubscribe
  then:
    - kind: markRead
    - kind: move
      folder: '推广'
`

describe('parseRules', () => {
  it('解析出规则并按 priority 排序', () => {
    const parsed = parseRules(SOURCE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rules.map(rule => rule.id)).toEqual(['github', 'promo'])
    expect(parsed.rules[0]?.when).toEqual([{ kind: 'from', any: ['notifications@github.com'] }])
    expect(parsed.rules[0]?.then).toHaveLength(2)
  })

  it('语法错误带行号——页面要指到那一行', () => {
    const parsed = parseRules('- id: x\n  name: [unclosed\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.line).toBeGreaterThan(0)
  })

  it('不认识的 version 拒绝加载而不是猜', () => {
    const parsed = parseRules('version: 2\nrules: []\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('版本')
  })

  it('顶层是对象但要带 rules', () => {
    const parsed = parseRules('version: 1\nrules:\n  - id: a\n    name: A\n    when: []\n    then:\n      - kind: markRead\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rules).toHaveLength(1)
  })
})

describe('定向修改保留注释与格式', () => {
  it('开关一条规则后，顶部与行尾注释都还在', () => {
    const edited = setRuleEnabled(SOURCE, 'github', false)
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.text).toContain('# 顶部的说明：为什么这么配')
    expect(edited.text).toContain('# 行尾注释也要留住')
    expect(edited.text).toContain('- id: promo')
    // 而且真的改到了那一条。
    const reparsed = parseRules(edited.text)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.rules.find(rule => rule.id === 'github')?.enabled).toBe(false)
    expect(reparsed.rules.find(rule => rule.id === 'promo')?.enabled).toBe(true)
  })

  it('改一个动作的三态只动那一处', () => {
    const edited = setActionMode(SOURCE, 'github', 1, 'off')
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const reparsed = parseRules(edited.text)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    const github = reparsed.rules.find(rule => rule.id === 'github')
    expect(github?.then[1]?.mode).toBe('off')
    // 第一个动作没被碰。
    expect(github?.then[0]?.mode).toBe('auto')
    expect(edited.text).toContain("workspaceTemplate: '{repoRoot}/{repo}'")
  })

  it('找不到规则或动作下标越界时回一句人话，而不是写坏文件', () => {
    expect(setRuleEnabled(SOURCE, 'nope', false)).toEqual({ ok: false, error: '找不到规则 nope' })
    const missing = setActionMode(SOURCE, 'github', 9, 'off')
    expect(missing.ok).toBe(false)
  })

  it('上下移交换的是 priority，注释仍然在', () => {
    const parsed = parseRules(SOURCE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const edited = swapPriority(SOURCE, 'promo', parsed.rules, 'up')
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const reparsed = parseRules(edited.text)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    // 顺序反过来了：promo 现在排在前面。
    expect(reparsed.rules.map(rule => rule.id)).toEqual(['promo', 'github'])
    expect(edited.text).toContain('# 顶部的说明：为什么这么配')
  })

  it('已经在最前面时拒绝上移', () => {
    const parsed = parseRules(SOURCE)
    if (!parsed.ok) return
    const edited = swapPriority(SOURCE, 'github', parsed.rules, 'up')
    expect(edited).toEqual({ ok: false, error: '已经在最前面' })
  })
})

describe('归一化：坏条目丢弃，其余照常工作', () => {
  it('一条写歪的规则不会拖垮另外两条', () => {
    const normalized = normalizeRules([
      { id: 'a', name: '好的', when: [], then: [{ kind: 'markRead' }] },
      { id: 'b', name: '坏的', when: [{ kind: 'nonsense' }], then: [{ kind: 'markRead' }] },
      { id: 'c', name: '也好的', when: [], then: [{ kind: 'flag' }] },
    ])
    expect(normalized.rules.map(rule => rule.id)).toEqual(['a', 'c'])
    expect(normalized.dropped).toHaveLength(1)
    expect(normalized.dropped[0]).toContain('坏的')
  })

  it('priority 缺省按位置乘十，id 缺省由名字派生并去重', () => {    const normalized = normalizeRules([
      { name: 'Same Name', when: [], then: [{ kind: 'markRead' }] },
      { name: 'Same Name', when: [], then: [{ kind: 'markRead' }] },
    ])
    expect(normalized.rules.map(rule => rule.priority)).toEqual([0, 10])
    expect(normalized.rules[0]?.id).not.toBe(normalized.rules[1]?.id)
  })

  it('followup 没有目标会话时整条规则被丢弃——投递不到总是失败', () => {
    const normalized = normalizeRules([
      { id: 'f', name: '投递', when: [], then: [{ kind: 'followup' }] },
      { id: 'g', name: '投递', when: [], then: [{ kind: 'followup', sessionId: 's-9' }] },
    ])
    expect(normalized.rules.map(rule => rule.id)).toEqual(['g'])
    expect(normalized.dropped[0]).toContain('then 里有写歪的动作')
  })

  it('动作三态缺省按「能不能撤销」定', () => {
    const normalized = normalizeRules([
      { id: 'x', name: 'X', when: [], then: [{ kind: 'markRead' }, { kind: 'script', command: 'echo' }] },
    ])
    expect(normalized.rules[0]?.then.map(action => action.mode)).toEqual(['auto', 'suggest'])
  })

  it('没有动作的规则被丢弃', () => {
    const normalized = normalizeRules([{ id: 'x', name: 'X', when: [], then: [] }])
    expect(normalized.rules).toHaveLength(0)
    expect(normalized.dropped[0]).toContain('then 是空的')
  })
})

describe('normalizeConfig', () => {
  it('缺省值可用，坏值退回默认', () => {
    const config = normalizeConfig({ undoWindowSeconds: 'nope', repoRoot: '  E:/repos  ' })
    expect(config.enabled).toBe(true)
    expect(config.dryRun).toBe(false)
    expect(config.undoWindowSeconds).toBe(120)
    expect(config.repoRoot).toBe('E:/repos')
  })

  it('允许把撤销窗口关掉', () => {
    expect(normalizeConfig({ undoWindowSeconds: 0 }).undoWindowSeconds).toBe(0)
  })
})

describe('发货默认规则', () => {
  /** 读包里的 `defaults/basic.yml`；它就是第一次启动时写给用户的那一份。 */
  function shipped(): string {
    return readFileSync(new URL('../../defaults/basic.yml', import.meta.url), 'utf8')
  }

  it('能解析、一条都不丢，且模型规则正好覆盖四类', () => {
    const parsed = parseRules(shipped())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.dropped).toEqual([])
    const labels = parsed.rules.flatMap(rule =>
      rule.when.flatMap(spec => (spec.kind === 'classifier' ? (spec.labels ?? []) : [])))
    // 顺序 = priority 顺序，也就是「候选类型」在提示词里出现的顺序。
    expect(labels).toEqual(['security', 'todo', 'dev', 'newsletter'])
  })

  it('每条模型规则只认一个类型，且都排在确定性快路径之后', () => {
    const parsed = parseRules(shipped())
    if (!parsed.ok) throw new Error(parsed.error.message)
    const model = parsed.rules.filter(rule => rule.when.some(spec => spec.kind === 'classifier'))
    expect(model).toHaveLength(4)
    for (const rule of model) {
      expect(rule.when).toHaveLength(1)
    }
    const firstModel = Math.min(...model.map(rule => rule.priority))
    const fast = parsed.rules.filter(rule => !rule.when.some(spec => spec.kind === 'classifier'))
    expect(fast.length).toBeGreaterThan(0)
    expect(Math.max(...fast.map(rule => rule.priority))).toBeLessThan(firstModel)
  })
})
