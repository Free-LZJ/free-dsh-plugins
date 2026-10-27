// @vitest-environment jsdom
/**
 * The rules view on screen: the rule file as it stands, what a rule does, and
 * what the engine did with the last few mails.
 *
 * Driven through a fake engine, exactly as the slot injects one: what these
 * tests pin is the page's own behaviour — it never invents a rule state, it says
 * so when the engine is absent rather than drawing an empty list, and every
 * control it offers is a write the engine actually accepts.
 *
 * @module @free-dsh-plugins/dsh-console/tests/rules-client
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RulesView, TriageUnavailable, conditionValue,
  type TriageResult, type TriageRule, type TriageRules, type TriageRun, type TriageSource,
} from '../src/client/rules.tsx'
import { zh, type Translate } from '../src/client/locales.ts'

afterEach(cleanup)

/** Translate through the real dictionary, so a missing key fails here too. */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** Two rules: one on subject, one fallback with a suggested move. */
const RULES: readonly TriageRule[] = [
  {
    id: 'github',
    name: 'GitHub 通知',
    enabled: true,
    priority: 10,
    when: [{ kind: 'subject', any: ['[Free-LZJ/', 'Run failed'] }],
    then: [{ kind: 'archive', mode: 'auto' }, { kind: 'mark-read' }],
  },
  {
    id: 'promo',
    name: '推广与电子报',
    enabled: false,
    priority: 20,
    when: [{ kind: 'header', name: 'list-id', any: ['promo.example'] }],
    then: [{ kind: 'move', mode: 'suggest', folder: '其他文件夹/广告' }],
  },
]

/** One run that can still be undone, and one whose window has closed. */
function runs(): readonly TriageRun[] {
  return [
    {
      id: 'run-live',
      at: '2026-10-27T08:00:00.000Z',
      ruleId: 'github',
      ruleName: 'GitHub 通知',
      label: 'GitHub 通知',
      message: { from: 'lzj@example.com', subject: '[Free-LZJ/free-dsh-plugins] Run failed: CI', folder: 'INBOX' },
      actions: [
        { kind: 'archive', mode: 'auto', ok: true, detail: '已移动到 归档' },
        { kind: 'mark-read', mode: 'auto', ok: false, detail: '标记已读失败：连接中断' },
      ],
      status: 'partial',
      undoableUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      id: 'run-dead',
      at: '2026-10-26T08:00:00.000Z',
      ruleId: 'promo',
      ruleName: '推广与电子报',
      label: '推广',
      message: { from: 'news@example.com', subject: '限时优惠', folder: 'INBOX' },
      actions: [{ kind: 'move', mode: 'auto', ok: true, detail: '已移动到 其他文件夹/广告' }],
      status: 'done',
      undoableUntil: new Date(Date.now() - 60_000).toISOString(),
    },
  ]
}

/** The engine, recording what it was asked to do. */
function engine(overrides: Partial<TriageSource> = {}) {
  const calls = {
    enabled: [] as { ruleId: string; enabled: boolean }[],
    priority: [] as { ruleId: string; direction: string }[],
    mode: [] as { ruleId: string; index: number; mode: string }[],
    undo: [] as string[],
  }
  const rules = (): Promise<TriageRules> => Promise.resolve({
    rules: RULES,
    source: 'file',
    path: 'C:/dsh/mail/triage/rules.yml',
    dropped: [],
  })
  const source: TriageSource = {
    rules,
    runs: async () => runs(),
    setEnabled: async (ruleId, enabled): Promise<TriageResult> => {
      calls.enabled.push({ ruleId, enabled })
      return { ok: true }
    },
    movePriority: async (ruleId, direction): Promise<TriageResult> => {
      calls.priority.push({ ruleId, direction })
      return { ok: true }
    },
    setMode: async (ruleId, index, mode): Promise<TriageResult> => {
      calls.mode.push({ ruleId, index, mode })
      return { ok: true }
    },
    undo: async (runId): Promise<TriageResult> => {
      calls.undo.push(runId)
      return { ok: true }
    },
    ...overrides,
  }
  return { calls, source }
}

/** Render the view and wait for the first read to land. */
async function draw(source: TriageSource): Promise<void> {
  render(<RulesView t={t} triage={source} />)
  await screen.findByRole('list', { name: t('rulesList', { count: 2 }) })
}

/** The rule list, as opposed to the hit records that repeat the same names. */
function ruleList(): HTMLElement {
  return screen.getByRole('list', { name: t('rulesList', { count: 2 }) })
}

/** One rule's card, by its name. */
function ruleOf(name: string): HTMLElement {
  return within(ruleList()).getByText(name).closest('li') as HTMLElement
}

describe('the rules view on screen', () => {
  it('draws each rule with its conditions and its actions', async () => {
    const { source } = engine()
    render(<RulesView t={t} triage={source} />)
    await screen.findByRole('list', { name: t('rulesList', { count: 2 }) })
    expect(within(ruleList()).getByText('GitHub 通知')).toBeTruthy()
    expect(within(ruleList()).getByText('推广与电子报')).toBeTruthy()
    // 条件用规则文件自己的词：kind + 值，不做一层会误导人的翻译。
    expect(screen.getByText('[Free-LZJ/ · Run failed')).toBeTruthy()
    expect(screen.getByText('list-id: promo.example')).toBeTruthy()
    // 动作与三态。
    expect(screen.getByRole('button', { name: t('ruleModeSuggest') })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: t('ruleModeAuto') }).length).toBe(2)
    // 启停状态是文字，不是只有颜色。
    expect(screen.getByText(t('ruleEnabled'))).toBeTruthy()
    expect(screen.getByText(t('ruleDisabled'))).toBeTruthy()
  })

  it('says where the rules came from and which file', async () => {
    const { source } = engine()
    render(<RulesView t={t} triage={source} />)
    expect(await screen.findByText(/C:\/dsh\/mail\/triage\/rules\.yml/)).toBeTruthy()
  })

  it('flips one rule on and off', async () => {
    const { calls, source } = engine()
    await draw(source)
    fireEvent.click(within(ruleOf('GitHub 通知')).getByRole('button', { name: t('ruleDisable') }))
    await waitFor(() => { expect(calls.enabled).toEqual([{ ruleId: 'github', enabled: false }]) })
  })

  it('moves a rule up or down, but not off the ends', async () => {
    const { calls, source } = engine()
    await draw(source)
    const first = ruleOf('GitHub 通知')
    const second = ruleOf('推广与电子报')
    // 第一条不能再往上，最后一条不能再往下。
    expect((within(first).getByRole('button', { name: t('ruleUp') }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(second).getByRole('button', { name: t('ruleDown') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(second).getByRole('button', { name: t('ruleUp') }))
    await waitFor(() => { expect(calls.priority).toEqual([{ ruleId: 'promo', direction: 'up' }]) })
  })

  it('turns one action into a suggestion', async () => {
    const { calls, source } = engine()
    await draw(source)
    fireEvent.click(screen.getAllByRole('button', { name: t('ruleModeAuto') })[0] as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: t('ruleModeSuggest') }))
    await waitFor(() => { expect(calls.mode).toEqual([{ ruleId: 'github', index: 0, mode: 'suggest' }]) })
  })

  it('shows what it did, and offers undo only while the window is open', async () => {
    const { calls, source } = engine()
    await draw(source)
    // 两次命中：一次部分完成（两个动作一对一次），一次已完成。
    expect(screen.getByText(t('ruleRunPartial'))).toBeTruthy()
    expect(screen.getByText('已移动到 归档')).toBeTruthy()
    expect(screen.getByText('标记已读失败：连接中断')).toBeTruthy()
    const undo = screen.getAllByRole('button', { name: t('ruleUndo') })
    // 只有仍在撤销窗口里的那次给了按钮。
    expect(undo.length).toBe(1)
    fireEvent.click(undo[0] as HTMLElement)
    await waitFor(() => { expect(calls.undo).toEqual(['run-live']) })
  })

  it('says the engine is absent instead of showing an empty rule file', async () => {
    // mail 没装：404 不是「没有规则」，页面上这两件事必须长得不一样。
    const { source } = engine({
      rules: async () => { throw new TriageUnavailable(404) },
    })
    render(<RulesView t={t} triage={source} />)
    expect(await screen.findByText(t('rulesUnavailable'))).toBeTruthy()
    expect(screen.queryByText(t('rulesNone'))).toBeNull()
  })

  it('reports a rule file that did not parse, and the rules it skipped', async () => {
    const { source } = engine({
      rules: async () => ({
        rules: RULES,
        error: { message: 'unexpected key "whenn"', line: 12 },
        source: 'file' as const,
        path: 'C:/dsh/mail/triage/rules.yml',
        dropped: ['规则 2：priority 不是数字'],
      }),
    })
    render(<RulesView t={t} triage={source} />)
    expect(await screen.findByText(new RegExp(t('rulesParseError', { message: 'unexpected key "whenn"' })))).toBeTruthy()
    expect(screen.getByText(new RegExp(t('rulesLine', { line: 12 })))).toBeTruthy()
    expect(screen.getByText(new RegExp('priority 不是数字'))).toBeTruthy()
  })

  it('says why a write did not take', async () => {
    const { source } = engine({
      setEnabled: async () => ({ ok: false, message: '规则文件是只读的' }),
    })
    await draw(source)
    fireEvent.click(within(ruleOf('GitHub 通知')).getByRole('button', { name: t('ruleDisable') }))
    expect(await screen.findByText('规则文件是只读的')).toBeTruthy()
  })
})

describe('condition values', () => {
  it('reads the rule file vocabulary without inventing words', () => {
    expect(conditionValue({ kind: 'subject', any: ['a', 'b'] })).toBe('a · b')
    expect(conditionValue({ kind: 'header', name: 'list-id', any: ['x'] })).toBe('list-id: x')
    expect(conditionValue({ kind: 'regex', field: 'subject', pattern: '^\\[Free-LZJ/' })).toBe('subject /^\\[Free-LZJ//')
    expect(conditionValue({ kind: 'attachment', has: true, extensions: ['.pdf'] })).toBe('.pdf')
    expect(conditionValue({ kind: 'attachment', has: true })).toBe('')
  })
})
