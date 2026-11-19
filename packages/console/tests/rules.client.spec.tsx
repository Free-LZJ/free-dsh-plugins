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
    then: [{ kind: 'archive' }, { kind: 'mark-read' }],
  },
  {
    id: 'promo',
    name: '推广与电子报',
    enabled: false,
    priority: 20,
    when: [{ kind: 'header', name: 'list-id', any: ['promo.example'] }],
    then: [{ kind: 'move', folder: '其他文件夹/广告' }],
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
      event: {
        from: 'lzj@example.com',
        subject: '[Free-LZJ/free-dsh-plugins] Run failed: CI',
        folder: 'INBOX',
        accountId: 'work',
        uid: 42,
      },
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
      event: { from: 'news@example.com', subject: '限时优惠', folder: 'INBOX', accountId: 'work', uid: 43 },
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
    undo: [] as string[],
    tested: [] as { accountId: string; folder: string; uid: number }[],
  }
  const rules = (): Promise<TriageRules> => Promise.resolve({
    rules: RULES,
    source: 'file',
    path: 'C:/dsh/dsh-console/rules/rules.yml',
    dropped: [],
    connector: true,
    unassigned: 0,
  })
  const source: TriageSource = {
    rules,
    runs: async () => runs(),
    flow: overrides.flow ?? (async () => ({ flows: [] })),
    nodeTypes: overrides.nodeTypes ?? (async () => []),
    saveFlowNode: overrides.saveFlowNode ?? (async () => ({ ok: true })),
    addFlowNode: overrides.addFlowNode ?? (async () => ({ ok: true })),
    addFlowScaffold: async () => ({ ok: true }),
    scaffoldFlows: async () => ({ ok: true }),
    createFlow: async () => ({ ok: true, flowId: 'flow-1' }),
    removeFlowNode: overrides.removeFlowNode ?? (async () => ({ ok: true })),
    relinkFlowEdge: overrides.relinkFlowEdge ?? (async () => ({ ok: true })),
    moveFlowEdge: async () => ({ ok: true }),
    addFlowEdge: async () => ({ ok: true }),
    saveFlowEdge: async () => ({ ok: true }),
    addRule: async () => ({ ok: true }),
    autoLayout: overrides.autoLayout ?? (async () => ({ ok: true })),
    setEnabled: async (ruleId, enabled): Promise<TriageResult> => {
      calls.enabled.push({ ruleId, enabled })
      return { ok: true }
    },
    movePriority: async (ruleId, direction): Promise<TriageResult> => {
      calls.priority.push({ ruleId, direction })
      return { ok: true }
    },
    setCondition: async (): Promise<TriageResult> => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    undo: async (runId): Promise<TriageResult> => {
      calls.undo.push(runId)
      return { ok: true }
    },
    testRun: overrides.testRun ?? (async (ref) => {
      calls.tested.push(ref)
      return { ok: true, result: { ruleId: 'github', ruleName: 'GitHub 通知', actions: [], reason: '按顺序第一条命中的规则。' } }
    }),
    ...overrides,
  }
  return { calls, source }
}

/** Render the view and wait for the first read to land. */
async function draw(source: TriageSource): Promise<void> {
  render(<RulesView t={t} triage={source} />)
  // 规则页默认落在编排视图；这些用例讲的是列表，所以先切过去。
  fireEvent.click(await screen.findByRole('button', { name: '列表' }))
  await screen.findByRole('list', { name: t('rulesList', { count: 2 }) })
}

/** 渲染规则页并切到列表视图；多数用例讲的是列表。 */
async function renderList(source: TriageSource): Promise<{ readonly container: HTMLElement }> {
  const { container } = render(<RulesView t={t} triage={source} />)
  fireEvent.click(await screen.findByRole('button', { name: '列表' }))
  return { container }
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
  it('没有邮件位置的命中记录：试跑按钮灰着，并说明原因', async () => {
    // 试跑要读那封真邮件，记录里没留下邮箱与 uid 就重跑不了。以前按钮直接不渲染，
    // 人会以为「这条规则不支持试跑」，而不是「这条记录缺东西」。
    const { source } = engine({
      runs: async () => [{
        id: 'run-bare',
        at: '2026-10-27T09:00:00.000Z',
        ruleId: 'github',
        ruleName: 'GitHub 通知',
        label: 'GitHub 通知',
        event: { from: 'lzj@example.com', subject: '没有邮件位置', folder: 'INBOX' },
        actions: [],
        status: 'done',
      } as unknown as TriageRun],
    })
    await renderList(source)
    const button = await screen.findByRole('button', { name: '试跑' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('这条记录没记下邮件在哪，重跑不了')
  })

  it('draws each rule with its conditions and its actions', async () => {
    const { source } = engine()
    await renderList(source)
    await screen.findByRole('list', { name: t('rulesList', { count: 2 }) })
    expect(within(ruleList()).getByText('GitHub 通知')).toBeTruthy()
    expect(within(ruleList()).getByText('推广与电子报')).toBeTruthy()
    // 条件用规则文件自己的词：kind + 值，不做一层会误导人的翻译。
    // 限定在列表里找：流程图上也会出现同样的文字，那是同一份数据画两遍。
    expect(within(ruleList()).getByText('[Free-LZJ/ · Run failed')).toBeTruthy()
    expect(within(ruleList()).getByText('list-id: promo.example')).toBeTruthy()
    // 动作是纯展示：列出来就会执行，没有开关可点。
    expect(within(ruleList()).getByText('archive')).toBeTruthy()
    expect(within(ruleList()).getByText('其他文件夹/广告')).toBeTruthy()
    expect(screen.queryByRole('menuitem')).toBeNull()
    // 启停状态是文字，不是只有颜色。
    expect(screen.getByText(t('ruleEnabled'))).toBeTruthy()
    expect(screen.getByText(t('ruleDisabled'))).toBeTruthy()
  })

  it('says where the rules came from without printing a local path', async () => {
    const { source } = engine()
    await renderList(source)
    // 抬头只说「来自文件」；本机绝对路径收进 title，点开原文时才在折叠区里看到。
    const line = await screen.findByText(t('rulesSource', { source: t('rulesSourceFile') }))
    expect(line.getAttribute('title')).toBe('C:/dsh/dsh-console/rules/rules.yml')
    expect(screen.queryByText(/C:\/dsh\/dsh-console\/rules\/rules\.yml/)).toBeNull()
  })

  it('可以只看没跑完的记录：问题不该被按时间排到下面去', async () => {
    const { source } = engine()
    await draw(source)
    const filter = await screen.findByRole('button', { name: '只看有问题的' })
    expect(filter.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(filter)
    await waitFor(() => { expect(screen.getByRole('button', { name: '只看有问题的（已开）' })).toBeTruthy() })
    // 开之前只说「其中 N 条没跑完」，开之后变成「N 条没跑完，共 M 条」——数字对得上。
    expect(screen.getByText(/条没跑完，共 2 条/)).toBeTruthy()
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

  it('点开一条命中记录，能看到它当时走了哪几步', async () => {
    const failed = {
      id: 'run-steps',
      at: '2026-10-27T12:00:00.000Z',
      ruleId: 'github',
      ruleName: 'GitHub 通知',
      label: 'GitHub 通知',
      event: { from: 'lzj@example.com', subject: '看步骤', folder: 'INBOX' },
      actions: [],
      status: 'failed' as const,
      nodes: [
        { nodeId: 'trigger', flowId: 'mail-new', kind: 'trigger', ok: true, detail: '事件 mail.received' },
        { nodeId: 'route', flowId: 'mail-new', kind: 'switch', ok: true, detail: '命中 call-github' },
        { nodeId: 'call-github', flowId: 'mail-new', kind: 'workflow', ok: false, detail: '第 2 步挂了', failure: 'transient' },
      ],
    }
    const { source } = engine({ runs: async () => [failed] })
    await draw(source)

    // 折起来时只说有几步：一屏里几十条记录，全铺开会没法看。
    const summary = await screen.findByText('过程（3 步）')
    fireEvent.click(summary)
    await waitFor(() => { expect(screen.getByText(/第 2 步挂了/)).toBeTruthy() })
    expect(screen.getByText(/transient/)).toBeTruthy()
  })

  it('没有步骤记录的老记录不摆一个空折叠块', async () => {
    const { source } = engine()
    await draw(source)
    expect(screen.queryByText(/过程（/)).toBeNull()
  })

  it('shows what it did, and offers undo only while the window is open', async () => {
    const { calls, source } = engine()
    await draw(source)
    // 两次命中：一次部分完成（两个动作一对一次），一次已完成。
    expect(screen.getByText(t('ruleRunPartial'))).toBeTruthy()
    expect(screen.getByText('已移动到 归档')).toBeTruthy()
    expect(screen.getByText('标记已读失败：连接中断')).toBeTruthy()
    const undo = screen.getAllByRole('button', { name: t('ruleUndo') })
    // 仍在窗口里的那次：可以点。
    expect((undo[0] as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(undo[0] as HTMLElement)
    await waitFor(() => { expect(calls.undo).toEqual(['run-live']) })
  })

  it('撤销窗口过了：按钮留着但灰着，鼠标停上去说明为什么不能用', async () => {
    const { source } = engine()
    await draw(source)
    // 第二次命中早已过期：它的按钮不该凭空消失。
    const expired = screen.getAllByRole('button', { name: t('ruleUndo') })
      .filter((button) => (button as HTMLButtonElement).disabled)
    expect(expired.length).toBe(1)
    expect(expired[0]?.getAttribute('title')).toBe(t('ruleUndoExpired'))
  })

  it('says the engine is absent when it does not answer at all', async () => {
    // 引擎没响应：这既不是「没有规则」，也不是「没有连接器」，页面上三件事必须分得开。
    const { source } = engine({
      rules: async () => { throw new TriageUnavailable(500) },
    })
    await renderList(source)
    expect(await screen.findByText(t('rulesUnavailable'))).toBeTruthy()
    expect(screen.queryByText(t('rulesNone'))).toBeNull()
    expect(screen.queryByText(t('rulesNoConnector'))).toBeNull()
  })

  it('says no connector provides rules instead of drawing an empty rule file', async () => {
    // 没装连接器（例如邮件）：规则引擎在，只是还没有谁把规则喂给它。
    const { source } = engine({
      rules: async () => ({
        rules: [],
        source: 'default' as const,
        path: 'C:/dsh/dsh-console/rules/rules.yml',
        dropped: [],
        connector: false,
        unassigned: 0,
      }),
    })
    await renderList(source)
    expect(await screen.findByText(t('rulesNoConnector'))).toBeTruthy()
    expect(screen.queryByText(t('rulesNone'))).toBeNull()
    expect(screen.queryByText(t('rulesUnavailable'))).toBeNull()
  })

  it('reports a rule file that did not parse, and the rules it skipped', async () => {
    const { source } = engine({
      rules: async () => ({
        rules: RULES,
        error: { message: 'unexpected key "whenn"', line: 12 },
        source: 'file' as const,
        path: 'C:/dsh/dsh-console/rules/rules.yml',
        dropped: ['规则 2：priority 不是数字'],
        connector: true,
        unassigned: 0,
      }),
    })
    await renderList(source)
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

describe('changing a rule', () => {
  /** Install a clipboard whose write either works or is refused. */
  function stubClipboard(kind: 'ok' | 'missing'): { written: string[] } {
    const written: string[] = []
    if (kind === 'ok') {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { written.push(text) } },
      })
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
    return { written }
  }

  it('hands the agent one rule\u2019s current definition', async () => {
    const clipboard = stubClipboard('ok')
    const { source } = engine()
    await draw(source)
    fireEvent.click(within(ruleOf('GitHub 通知')).getByRole('button', { name: t('ruleCopyFix') }))
    await waitFor(() => { expect(clipboard.written.length).toBe(1) })
    const instruction = clipboard.written[0] as string
    // 指令要能独立读懂：改哪个文件、哪条规则、它现在长什么样。
    expect(instruction).toContain('C:/dsh/dsh-console/rules/rules.yml')
    expect(instruction).toContain('github')
    expect(instruction).toContain('"when"')
    expect(await screen.findByText(t('ruleCopyDone'))).toBeTruthy()
  })

  it('shows the instruction when there is no clipboard', async () => {
    // 非安全上下文里 clipboard 是 undefined：静默失败比没有按钮更糟，所以退化成显示原文。
    stubClipboard('missing')
    const { source } = engine()
    await draw(source)
    fireEvent.click(within(ruleOf('GitHub 通知')).getByRole('button', { name: t('ruleCopyFix') }))
    const fallback = await screen.findByText(new RegExp(t('ruleCopyFallback')))
    expect(fallback.textContent).toContain('"when"')
  })

  it('dry-runs the current rules against that record\u2019s mail, changing nothing', async () => {
    const { calls, source } = engine()
    await draw(source)
    fireEvent.click(within(screen.getByText(/Run failed: CI/).closest('li') as HTMLElement)
      .getByRole('button', { name: t('ruleTest') }))
    await waitFor(() => { expect(calls.tested).toEqual([{ accountId: 'work', folder: 'INBOX', uid: 42 }]) })
    // 试跑只回答「会怎样」，不产生动作。
    expect(await screen.findByText(new RegExp(t('ruleTestResult', { rule: 'GitHub 通知', reason: '' }).split('·')[0] as string))).toBeTruthy()
    expect(screen.getByText(/按顺序第一条命中的规则/)).toBeTruthy()
  })

  it('reports why a dry run could not be made', async () => {
    const { source } = engine({
      testRun: async () => ({ ok: false as const, message: '这封邮件已经不在了' }),
    })
    await draw(source)
    fireEvent.click(within(screen.getByText(/Run failed: CI/).closest('li') as HTMLElement)
      .getByRole('button', { name: t('ruleTest') }))
    expect(await screen.findByText(new RegExp(t('ruleTestFailed', { message: '这封邮件已经不在了' })))).toBeTruthy()
  })

  it('offers no dry run for a record with no mailbox reference', async () => {
    // 旧记录可能没存 accountId：不发必然被拒的请求，但**按钮要留着**（灰着）——
    // 凭空消失会让人以为「这条规则不支持试跑」，而不是「这条记录缺东西」。
    const { source } = engine({
      runs: async () => [{ ...(runs()[0] as TriageRun), event: { from: 'a@b', subject: 'x', folder: 'INBOX' } }],
    })
    await draw(source)
    const button = screen.getByRole('button', { name: t('ruleTest') }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe(t('ruleTestNoMail'))
  })

  it('shows the file itself when the engine hands it over', async () => {
    const { source } = engine({
      rules: async () => ({
        rules: RULES,
        source: 'file' as const,
        path: 'C:/dsh/dsh-console/rules/rules.yml',
        dropped: [],
        connector: true,
        unassigned: 0,
        raw: 'rules:\n  - id: github\n',
      }),
    })
    await draw(source)
    expect(await screen.findByText(t('ruleRawTitle'))).toBeTruthy()
    expect(screen.getByText(/id: github/)).toBeTruthy()
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

