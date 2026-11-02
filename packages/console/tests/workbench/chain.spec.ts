/**
 * 链路推断：把没有根的卡按标题与时间聚起来。
 *
 * 夹具取的是真实板上的六张卡（同一批 E2E 测试留下的），因为它们正好覆盖了这个
 * 问题的两个形状：一眼能看出是同一件事的（`[邮件] DSH E2E 派单` + `DSH E2E 子会话`），
 * 和只有弱词相同的（两张不同往来的 `jira`）。
 *
 * @module @free-dsh-console/tests/workbench/chain
 */

import { describe, expect, it } from 'vitest'
import { inferChains, sharesChainTokens, titleTokens } from '../../src/workbench/chain.ts'

/** 一刻钟，用来把夹具的时间错开。 */
const MINUTE = 60 * 1000

/**
 * 造一张卡。
 * @param id - 卡片 id。
 * @param title - 标题。
 * @param minutesAgo - 相对「现在」的分钟数。
 * @returns 推断只需要的那几个字段。
 */
function card(id: string, title: string, minutesAgo: number) {
  return { id, title, createdAt: 1_000_000 - minutesAgo * MINUTE }
}

describe('titleTokens', () => {
  it('drops the source mark and the timestamps, keeps identifiers whole', () => {
    const tokens = titleTokens('[邮件] DSH E2E 派单：[DSH-E2E] 工作台全链路测试 2026-10-30 15:50')
    expect(tokens.has('dsh')).toBe(true)
    expect(tokens.has('e2e')).toBe(true)
    expect(tokens.has('工作台全链路测试')).toBe(true)
    // 日期与时刻不是证据。
    expect([...tokens].some(token => /\d{4}-\d{1,2}-\d{1,2}/u.test(token))).toBe(false)
    // 来源标记与通用动词都不是证据。
    expect(tokens.has('邮件')).toBe(false)
  })

  it('keeps a hyphenated ticket number as one token', () => {
    expect(titleTokens('Jira EXEPD-229676：手势退出对话页后恢复陪练').has('exepd-229676')).toBe(true)
  })
})

describe('sharesChainTokens', () => {
  it('needs two weak words or one strong identifier', () => {
    expect(sharesChainTokens(titleTokens('DSH E2E 派单'), titleTokens('DSH E2E 子会话'))).toBe(true)
    // 只共享一个弱词不算。
    expect(sharesChainTokens(titleTokens('jira 派单'), titleTokens('jira 归档'))).toBe(false)
    // 一个带数字的长词就够。
    expect(sharesChainTokens(
      titleTokens('Jira EXEPD-229676：手势退出'),
      titleTokens('EXEPD-229676 已修复'),
    )).toBe(true)
  })
})

describe('inferChains', () => {
  it('merges the cards a human would call one piece of work, and nothing else', () => {
    const cards = [
      card('c1', 'jira', 210),
      card('c2', '[邮件] Jira 派单：Jira-System (EXEPD-229676) dev，用户通过手势左右滑', 274),
      card('c3', 'Jira EXEPD-229676：手势退出对话页后恢复陪练，时长统计偏短', 273),
      card('c4', 'Jira EXEPD-229676：手势退出对话页后恢复陪练时长统计偏短', 165),
      card('c5', '[邮件] DSH E2E 派单：[DSH-E2E] 工作台全链路测试 2026-10-30 15:50', 61),
      card('c6', 'DSH E2E 子会话', 61),
    ]
    expect(inferChains(cards)).toEqual([
      { rootId: 'c2', cardIds: ['c3', 'c4'] },
      { rootId: 'c5', cardIds: ['c6'] },
    ])
  })

  it('leaves an already-chained card alone', () => {
    // 有根说明有人明确说过它属于谁：推断不许改写别人的决定。
    const cards = [
      card('c1', 'DSH E2E 派单', 10),
      { ...card('c2', 'DSH E2E 子会话', 9), rootId: 'somewhere-else' },
    ]
    expect(inferChains(cards)).toEqual([])
  })

  it('does not weld two events that only share a generic word', () => {
    const cards = [
      card('c1', 'Jira EXEPD-111111：登录页白屏', 200),
      card('c2', 'Jira 归档：登录页白屏', 100),
    ]
    expect(inferChains(cards)).toEqual([])
  })

  it('stops at the window and at the step cap', () => {
    const far = [card('a', 'DSH E2E 派单', 300), card('b', 'DSH E2E 子会话', 10)]
    expect(inferChains(far)).toEqual([])

    const many = Array.from({ length: 10 }, (_, index) =>
      card(`m${String(index)}`, `DSH E2E 全链路测试 ${String(index)}`, 60 - index))
    const [chain] = inferChains(many)
    expect(chain?.cardIds).toHaveLength(7)
  })
})
