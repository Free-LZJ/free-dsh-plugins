// @vitest-environment jsdom
/**
 * 看板：一个任务一条链。
 *
 * 这一层钉住的是**分区与分组判断**，不是像素：失败必须留在待办里等人处理，会话还
 * 活着必须在进行中，走完的按归档节奏离开板面；一个任务的链就是它自己的节点。
 *
 * @module @dsh-console/tests/workbench/board
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { zh, type Translate } from '../../src/client/locales.ts'
import {
  BoardView, buildTasks, dimensionLabel, groupArchived, kindLabel, remedyOf,
  type BoardFace,
} from '../../src/client/workbench/board.tsx'
import type { Task, TaskNodeRecord } from '../../src/protocol.ts'

/** The Chinese dictionary as a translate seat. */
const t: Translate = ((key: string, params?: Record<string, string | number>) => {
  const template = (zh as unknown as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}) as Translate

/** 一个动作节点，按旧测试的写法给。 */
interface ActionLike {
  readonly kind: string
  readonly ok: boolean
  readonly detail: string
  readonly sessionId?: string
  readonly failure?: 'config' | 'transient' | 'fatal'
}

const AT = '2026-11-06T10:00:00.000Z'

/** 一个任务；`actions` 会被转成链上的动作节点。 */
function task(overrides: Partial<Task> & { readonly id: string; readonly actions?: readonly ActionLike[] }): Task {
  const { actions, ...rest } = overrides
  const nodes: TaskNodeRecord[] = [
    { id: `${overrides.id}:trigger`, kind: 'trigger', at: rest.at ?? AT, ok: true, detail: '收到' },
    {
      id: `${overrides.id}:rule`,
      kind: 'rule',
      at: rest.at ?? AT,
      ok: true,
      detail: 'Jira bug',
      data: { ruleId: 'jira-bug', ruleName: 'Jira bug', label: 'bug' },
    },
    ...(actions ?? []).map((action, index) => ({
      id: `${overrides.id}:${String(index)}`,
      kind: action.kind,
      at: rest.at ?? AT,
      ok: action.ok,
      detail: action.detail,
      actionIndex: index,
      ...(action.sessionId === undefined ? {} : { sessionId: action.sessionId }),
      ...(action.failure === undefined ? {} : { failure: action.failure }),
    })),
  ]
  return {
    connector: 'mail',
    triggerId: 'mail:new',
    key: 'mail:acc-1:INBOX:42',
    title: 'EXEPD-1 崩了',
    at: AT,
    updatedAt: AT,
    status: 'done',
    ...rest,
    nodes: rest.nodes ?? nodes,
  }
}

/** A face whose only job is to answer what the view asks while rendering. */
function face(overrides: Partial<BoardFace> = {}): BoardFace {
  return {
    tasks: () => [],
    running: () => [],
    rhythm: () => 'immediate',
    setRhythm: () => {},
    rhythmMs: () => 0,
    undo: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    openRules: () => {},
    flow: async () => ({ flows: [], nodeTypes: [] }),
    canJumpTo: () => false,
    jumpTo: () => ({ ok: false }),
    ...overrides,
  }
}

afterEach(() => { cleanup() })

describe('一个任务一条链', () => {
  it('链就是任务自己的节点，按发生顺序', () => {
    const one = task({
      id: 't1',
      actions: [{ kind: 'markRead', ok: true, detail: '已标记为已读' }],
    })
    const tasks = buildTasks([one], new Set(), 0, Date.now(), t)
    expect(tasks).toHaveLength(1)
    // 触发 + 规则 + 动作。
    expect(tasks[0]?.steps.map(step => step.kind)).toEqual(['trigger', 'rule', 'markRead'])
    expect(tasks[0]?.tasks).toHaveLength(1)
  })

  it('两个任务就是两张卡，Host 负责把同一件事合并成一条', () => {
    const one = task({ id: 't1' })
    const two = task({ id: 't2', title: '另一封', key: 'mail:acc-1:INBOX:43' })
    expect(buildTasks([one, two], new Set(), 0, Date.now(), t)).toHaveLength(2)
  })
})

describe('任务落在哪个区', () => {
  it('有失败动作就留在待办，等人工处理', () => {
    const failed = task({
      id: 't1',
      status: 'partial',
      actions: [{ kind: 'notify', ok: false, detail: '通知没发出去' }],
    })
    const tasks = buildTasks([failed], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('todo')
    expect(tasks[0]?.failed).toBe(true)
  })

  it('会话还活着就是进行中', () => {
    const withSession = task({
      id: 't1',
      actions: [{ kind: 'session', ok: true, detail: '已开会话', sessionId: 's-1' }],
    })
    const tasks = buildTasks([withSession], new Set(['s-1']), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('running')
  })

  it('走完且节奏是「结束即归档」时立刻归档', () => {
    const done = task({ id: 't1' })
    const tasks = buildTasks([done], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('archived')
  })

  it('时间窗口没过完就还在板上', () => {
    const done = task({ id: 't1', updatedAt: new Date().toISOString(), at: new Date().toISOString() })
    const tasks = buildTasks([done], new Set(), 60_000, Date.now(), t)
    expect(tasks[0]?.zone).toBe('todo')
  })
})

describe('归档按维度分组', () => {
  /** 三个结局各异的任务。 */
  function three(): readonly Task[] {
    return [
      task({
        id: 'failed',
        status: 'partial',
        actions: [{ kind: 'notify', ok: false, detail: '没发出去' }],
      }),
      task({ id: 'dismissed', acknowledged: true }),
      task({ id: 'done' }),
    ]
  }

  it('按结局：失败在前、手动收起居中、顺利做完在后，空组不出现', () => {
    const chains = buildTasks(three(), new Set(), 0, Date.now(), t)
    const groups = groupArchived(chains, 'outcome', t)
    expect(groups.map(group => group.label)).toEqual(['失败过', '手动收起', '顺利做完'])
    expect(groups.every(group => group.tasks.length > 0)).toBe(true)
  })

  it('只有一种结局时只给一组', () => {
    const chains = buildTasks([task({ id: 'only' })], new Set(), 0, Date.now(), t)
    expect(groupArchived(chains, 'outcome', t)).toHaveLength(1)
  })

  it('既失败又收起的，算「失败过」——人记住的是它失败过', () => {
    const both = task({
      id: 'both',
      status: 'partial',
      acknowledged: true,
      actions: [{ kind: 'notify', ok: false, detail: '没发出去' }],
    })
    const chains = buildTasks([both], new Set(), 0, Date.now(), t)
    expect(groupArchived(chains, 'outcome', t)[0]?.label).toBe('失败过')
  })

  it('按规则：用规则节点说的规则名', () => {
    const chains = buildTasks([task({ id: 'a' })], new Set(), 0, Date.now(), t)
    expect(groupArchived(chains, 'rule', t)[0]?.label).toBe('Jira bug')
  })

  it('没有分支节点的任务归到「没有分支」', () => {
    const noRule = task({ id: 'b', nodes: [{ id: 'n', kind: 'trigger', at: AT, ok: true, detail: '收到' }] })
    const chains = buildTasks([noRule], new Set(), 0, Date.now(), t)
    expect(groupArchived(chains, 'rule', t)[0]?.label).toBe('没有分支')
  })

  it('按来源：一个来源一组', () => {
    const chains = buildTasks([task({ id: 'a' }), task({ id: 'b', connector: 'jira' })], new Set(), 0, Date.now(), t)
    expect(groupArchived(chains, 'source', t)).toHaveLength(2)
  })

  it('按日期：由新到旧，今天叫「今天」', () => {
    const now = Date.now()
    const chains = buildTasks([task({ id: 'a', at: new Date(now).toISOString() })], new Set(), 0, now, t)
    expect(groupArchived(chains, 'day', t, now)[0]?.label).toBe('今天')
  })

  it('每个维度都有中文名', () => {
    for (const dimension of ['outcome', 'source', 'rule', 'day'] as const) {
      expect(dimensionLabel(dimension, t)).not.toBe(dimension)
    }
  })
})

describe('动作名的说法', () => {
  it('认识的种类说人话，不认识的照原样', () => {
    expect(kindLabel('markRead', t)).toBe('标记已读')
    expect(kindLabel('session', t)).toBe('开会话')
    expect(kindLabel('whatever', t)).toBe('whatever')
  })
})

describe('失败之后人还能做什么', () => {
  it('配置错给「去改规则」，临时故障给「重试」，目标没了什么都不给', () => {
    expect(remedyOf('config')).toBe('fix-config')
    expect(remedyOf('transient')).toBe('retry')
    expect(remedyOf('fatal')).toBe('none')
    expect(remedyOf(undefined)).toBe('none')
  })

  it('失败的性质从最早失败的那一步读出来，并带到任务上', () => {
    const failed = task({
      id: 't1',
      status: 'partial',
      actions: [
        { kind: 'markRead', ok: false, detail: '连接断了', failure: 'transient' },
        { kind: 'notify', ok: false, detail: '没发出去', failure: 'config' },
      ],
    })
    const chains = buildTasks([failed], new Set(), 0, Date.now(), t)
    expect(chains[0]?.failure).toBe('transient')
    expect(chains[0]?.remedy).toBe('retry')
  })
})

describe('人说过「我看到了」以后', () => {
  it('失败的任务不再占待办，直接进归档', () => {
    const failed = task({
      id: 't1',
      status: 'partial',
      acknowledged: true,
      actions: [{ kind: 'notify', ok: false, detail: '没发出去' }],
    })
    expect(buildTasks([failed], new Set(), 0, Date.now(), t)[0]?.zone).toBe('archived')
  })
})

describe('看板画出来', () => {
  it('一张卡点开是详情弹窗，链路在里面', async () => {
    const now = Date.now()
    const at = new Date(now).toISOString()
    const one = task({
      id: 't1',
      at,
      updatedAt: at,
      actions: [{ kind: 'markRead', ok: true, detail: '已标记为已读' }],
    })
    // 留在待办区才有卡可点：归档区默认是收着的。
    const board = face({ tasks: () => [one], rhythmMs: () => 60_000 })
    render(<BoardView face={board} t={t} data={{ tasks: buildTasks([one], new Set(), 60_000, now, t), loaded: true, error: '' }} />)
    fireEvent.click(screen.getByLabelText('EXEPD-1 崩了'))
    await waitFor(() => { expect(screen.getByText('已标记为已读')).toBeTruthy() })
  })

  it('忽略之后立刻重读，不等下一次轮询', async () => {
    let reloaded = 0
    const one = task({ id: 't1', status: 'partial', actions: [{ kind: 'notify', ok: false, detail: '没发出去' }] })
    const board = face({
      tasks: () => [one],
      acknowledge: async () => ({ ok: true }),
    })
    render(<BoardView face={board} t={t} data={{ tasks: buildTasks([one], new Set(), 0, Date.now(), t), loaded: true, error: '' }} reload={() => { reloaded += 1 }} />)
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
    await waitFor(() => { expect(screen.getByText('忽略')).toBeTruthy() })
    fireEvent.click(screen.getByText('忽略'))
    await waitFor(() => { expect(reloaded).toBeGreaterThan(0) })
  })


  it('跑到哪一格就点亮哪一格，下一步也标出来', async () => {
    const now = Date.now()
    const at = new Date(now).toISOString()
    // 正在跑的那一格还没有记录（执行器只在跑完时落一条），所以它只能来自进度。
    const one = task({
      id: 't1',
      at,
      updatedAt: at,
      status: 'running',
      progress: { done: [], satisfied: [], ready: ['call-jira'], running: ['route'] },
    })
    render(<BoardView face={face()} t={t} data={{ tasks: buildTasks([one], new Set(), 60_000, now, t), loaded: true, error: '' }} />)
    // 「进行中」列的说明文字也叫「正在跑」，所以按 class 找链路里的标记。
    await waitFor(() => { expect(document.querySelectorAll('.dshc-chain-mark').length).toBe(2) })
    const marks = Array.from(document.querySelectorAll('.dshc-chain-mark'), el => el.textContent)
    expect(marks).toEqual(['正在跑', '下一步'])
    expect(screen.getByText('route')).toBeTruthy()
    expect(screen.getByText('call-jira')).toBeTruthy()
  })

  it('点开一步能看到这一步跑了多久、产出了什么', async () => {
    const now = Date.now()
    const at = new Date(now).toISOString()
    const later = new Date(now + 2000).toISOString()
    const one = task({
      id: 't1',
      at,
      updatedAt: at,
      nodes: [
        { id: 'n1', kind: 'http', at, ok: true, detail: '调了接口', data: { status: 200 } },
        { id: 'n2', kind: 'end', at: later, ok: true, detail: '结束' },
      ],
    })
    render(<BoardView face={face()} t={t} data={{ tasks: buildTasks([one], new Set(), 60_000, now, t), loaded: true, error: '' }} />)
    fireEvent.click(screen.getByLabelText('EXEPD-1 崩了'))
    await waitFor(() => { expect(screen.getByText('耗时 2.0s')).toBeTruthy() })
    expect(document.querySelector('.dshc-chain-data')?.textContent).toContain('\"status\": 200')
  })

  it('没有任务时只说一句话，不画三个空框', () => {
    render(<BoardView face={face()} t={t} data={{ tasks: [], loaded: true, error: '' }} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('引擎读不到时说清是没数据，而不是空看板', () => {
    render(<BoardView face={face()} t={t} data={{ tasks: [], loaded: true, error: '看板读不到' }} />)
    expect(screen.getByText('看板读不到')).toBeTruthy()
  })
})

describe('复制任务 ID', () => {
  /** 装一个只记录写入的剪贴板。 */
  function stubClipboard(): string[] {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text) } },
    })
    return written
  }

  it('点一下就复制这张卡的任务 id，并回一句已复制', async () => {
    const written = stubClipboard()
    const now = Date.now()
    const at = new Date(now).toISOString()
    const one = task({ id: 'tsk-42', at, updatedAt: at })
    render(<BoardView face={face()} t={t} data={{ tasks: buildTasks([one], new Set(), 60_000, now, t), loaded: true, error: '' }} />)
    fireEvent.click(screen.getByRole('button', { name: t('copyTaskId') }))
    await waitFor(() => { expect(written).toEqual(['tsk-42']) })
    expect(await screen.findByText(t('copyTaskIdDone'))).toBeTruthy()
  })
})
