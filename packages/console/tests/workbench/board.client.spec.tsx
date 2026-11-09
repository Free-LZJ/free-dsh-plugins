// @vitest-environment jsdom
/**
 * 看板：一次触发一条链路。
 *
 * 这一层钉住的是**聚合与分区的判断**，不是像素：同一个任务的多次命中必须折成
 * 一张卡（用户说的「同一件事不要出现第二个卡片」），失败必须留在待办里等人处理，
 * 会话还活着必须在进行中，走完的按归档节奏离开板面。
 *
 * @module @dsh-console/tests/workbench/board
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { zh, type Translate } from '../../src/client/locales.ts'
import {
  BoardView, buildTasks, dimensionLabel, groupArchived, kindLabel, remedyOf, taskKeyOf,
  type BoardFace, type TaskChain,
} from '../../src/client/workbench/board.tsx'
import type { TriageRun, TriageSource } from '../../src/client/rules.tsx'

/** The Chinese dictionary as a translate seat. */
const t: Translate = ((key: string, params?: Record<string, string | number>) => {
  const template = (zh as unknown as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}) as Translate

/** One hit record, with only the fields this layer reads. */
function run(overrides: Partial<TriageRun> & { readonly id: string }): TriageRun {
  return {
    at: new Date('2026-11-06T10:00:00Z').toISOString(),
    ruleId: 'jira-bug',
    ruleName: 'Jira bug',
    label: 'bug',
    event: { from: 'a@b.c', subject: 'EXEPD-1 崩了', folder: 'INBOX', accountId: 'acc-1', uid: 42 },
    actions: [],
    status: 'done',
    ...overrides,
  } as TriageRun
}

/** A face whose only job is to answer what the view asks while rendering. */
function face(overrides: Partial<BoardFace> = {}): BoardFace {
  const triage = {
    runs: async () => [],
  } as unknown as TriageSource
  return {
    triage,
    running: () => [],
    rhythm: () => 'immediate',
    setRhythm: () => {},
    rhythmMs: () => 0,
    acknowledge: async () => ({ ok: true }),
    openRules: () => {},
    ...overrides,
  }
}

afterEach(() => { cleanup() })

describe('把命中记录折成任务', () => {
  it('同一封邮件的多次触发是一条任务，不是好几张卡', () => {
    const first = run({ id: 'run-1' })
    const second = run({
      id: 'run-2',
      at: new Date('2026-11-06T10:05:00Z').toISOString(),
      actions: [{ kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' }],
    })
    expect(taskKeyOf(first)).toBe(taskKeyOf(second))
    const tasks = buildTasks([first, second], new Set(), 0, Date.now(), t)
    expect(tasks).toHaveLength(1)
    // 两次触发各自的规则步 + 第二次的动作步。
    expect(tasks[0]?.runs).toHaveLength(2)
    expect(tasks[0]?.steps.filter(step => step.kind === 'rule')).toHaveLength(2)
  })

  it('不同的事件是两个任务', () => {
    const one = run({ id: 'run-1' })
    const two = run({
      id: 'run-2',
      event: { from: 'x@y.z', subject: '另一封', folder: 'INBOX', accountId: 'acc-1', uid: 43 },
    })
    expect(taskKeyOf(one)).not.toBe(taskKeyOf(two))
    expect(buildTasks([one, two], new Set(), 0, Date.now(), t)).toHaveLength(2)
  })

  it('连接器给不出身份时，一条记录自成一条任务', () => {
    const anonymous = run({ id: 'run-9', event: { from: 'a@b.c', subject: '没有 uid', folder: 'INBOX' } as TriageRun['event'] })
    expect(taskKeyOf(anonymous)).toBe('run:run-9')
  })
})

describe('任务落在哪个区', () => {
  it('有失败动作就留在待办，等人工处理', () => {
    const failed = run({
      id: 'run-1',
      status: 'partial',
      actions: [{ kind: 'notify', mode: 'auto', ok: false, detail: '通知没发出去' }],
    })
    const tasks = buildTasks([failed], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('todo')
    expect(tasks[0]?.failed).toBe(true)
  })

  it('会话还活着就是进行中', () => {
    const withSession = run({
      id: 'run-1',
      actions: [{ kind: 'session', mode: 'auto', ok: true, detail: '已开会话', sessionId: 's-1' }],
    })
    const tasks = buildTasks([withSession], new Set(['s-1']), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('running')
  })

  it('走完且节奏是「结束即归档」时立刻归档', () => {
    const done = run({
      id: 'run-1',
      actions: [{ kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' }],
    })
    const tasks = buildTasks([done], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('archived')
  })

  it('时间窗口没过完就还在板上', () => {
    const done = run({
      id: 'run-1',
      at: new Date().toISOString(),
      actions: [{ kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' }],
    })
    const quarter = buildTasks([done], new Set(), 15 * 60 * 1000, Date.now(), t)
    expect(quarter[0]?.zone).toBe('todo')
    const later = buildTasks([done], new Set(), 15 * 60 * 1000, Date.now() + 20 * 60 * 1000, t)
    expect(later[0]?.zone).toBe('archived')
  })
})

describe('归档按维度分组', () => {
  /** 一条任务，按它是怎么结束的造出来（分组只看 failed / acknowledged）。 */
  const archivedTask = (key: string, ended: 'done' | 'failed' | 'dismissed'): TaskChain => {
    const failed = ended === 'failed'
    const made = buildTasks([run({
      id: key,
      ...(failed ? { status: 'partial' as const } : {}),
      ...(ended === 'dismissed' ? { acknowledged: true } : {}),
      actions: failed
        ? [{ kind: 'session', mode: 'auto', ok: false, detail: 'x', failure: 'config' as const }]
        : [{ kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' }],
    })], new Set(), 0, Date.now(), t)
    return made[0] as TaskChain
  }

  it('按结局：失败在前、手动收起居中、顺利做完在后，空组不出现', () => {
    const groups = groupArchived([
      archivedTask('a', 'done'),
      archivedTask('b', 'failed'),
      archivedTask('c', 'dismissed'),
      archivedTask('d', 'done'),
    ], 'outcome', t)
    expect(groups.map(group => group.key)).toEqual(['failed', 'dismissed', 'done'])
    expect(groups.find(group => group.key === 'done')?.tasks).toHaveLength(2)
  })

  it('只有一种结局时只给一组', () => {
    const groups = groupArchived([archivedTask('a', 'done'), archivedTask('b', 'done')], 'outcome', t)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('done')
    expect(groupArchived([], 'outcome', t)).toEqual([])
  })

  it('既失败又收起的，算「失败过」——人记住的是它失败过', () => {
    const task = archivedTask('a', 'failed')
    const groups = groupArchived([{ ...task, acknowledged: true }], 'outcome', t)
    expect(groups[0]?.key).toBe('failed')
  })

  it('按规则：用最新一次命中说的规则名', () => {
    const groups = groupArchived([
      archivedTask('a', 'done'),
      archivedTask('b', 'done'),
    ], 'rule', t)
    // 夹具里两条都属于同一条规则，所以是一组。
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('Jira bug')
  })

  it('按来源：一个来源一组', () => {
    const groups = groupArchived([archivedTask('a', 'done')], 'source', t)
    expect(groups[0]?.key).toBe('mail')
  })

  it('按日期：由新到旧，今天叫「今天」', () => {
    const now = Date.parse('2026-11-09T10:00:00Z')
    const fresh = archivedTask('a', 'done')
    const older = { ...archivedTask('b', 'done'), updatedAt: now - 3 * 24 * 60 * 60 * 1000 }
    const groups = groupArchived([older, { ...fresh, updatedAt: now }], 'day', t, now)
    expect(groups[0]?.label).toBe(zh.dayToday)
    expect(groups).toHaveLength(2)
  })

  it('每个维度都有中文名', () => {
    expect(dimensionLabel('outcome', t)).toBe(zh.archiveDimOutcome)
    expect(dimensionLabel('rule', t)).toBe(zh.archiveDimRule)
  })
})

describe('动作名的说法', () => {
  it('认识的种类说人话，不认识的照原样', () => {
    expect(kindLabel('session', t)).toBe(zh.linkKindSession)
    expect(kindLabel('markRead', t)).toBe(zh.linkKindMarkRead)
    expect(kindLabel('brand-new-kind', t)).toBe('brand-new-kind')
  })
})

describe('失败之后人还能做什么', () => {
  it('配置错给「去改规则」，临时故障给「重试」，目标没了什么都不给', () => {
    expect(remedyOf('config')).toBe('fix-config')
    expect(remedyOf('transient')).toBe('retry')
    expect(remedyOf('fatal')).toBe('none')
    // 引擎没标性质的老记录：不给一个按不动的按钮。
    expect(remedyOf(undefined)).toBe('none')
  })

  it('失败的性质从最早失败的那一步读出来，并带到任务上', () => {
    const failed = run({
      id: 'run-1',
      status: 'partial',
      actions: [
        { kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' },
        { kind: 'session', mode: 'auto', ok: false, detail: '模板缺 {repo}', failure: 'config' },
      ],
    })
    const tasks = buildTasks([failed], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.failure).toBe('config')
    expect(tasks[0]?.remedy).toBe('fix-config')
  })
})

describe('人说过「我看到了」以后', () => {
  it('失败的任务不再占待办，直接进归档', () => {
    const failed = run({
      id: 'run-1',
      status: 'partial',
      actions: [{ kind: 'session', mode: 'auto', ok: false, detail: '模板缺 {repo}', failure: 'config' }],
    })
    const before = buildTasks([failed], new Set(), 0, Date.now(), t)
    expect(before[0]?.zone).toBe('todo')
    expect(before[0]?.acknowledged).toBe(false)

    const after = buildTasks([{ ...failed, acknowledged: true }], new Set(), 0, Date.now(), t)
    expect(after[0]?.zone).toBe('archived')
    expect(after[0]?.acknowledged).toBe(true)
  })

  it('一次任务只在它每一次命中都被标记后才算收起来', () => {
    const first = run({ id: 'run-1', acknowledged: true, status: 'partial', actions: [
      { kind: 'session', mode: 'auto', ok: false, detail: 'x', failure: 'config' },
    ] })
    const second = run({
      id: 'run-2',
      at: new Date('2026-11-06T10:05:00Z').toISOString(),
      status: 'partial',
      actions: [{ kind: 'session', mode: 'auto', ok: false, detail: 'y', failure: 'config' }],
    })
    const tasks = buildTasks([first, second], new Set(), 0, Date.now(), t)
    expect(tasks[0]?.zone).toBe('todo')
  })
})

describe('看板画出来', () => {
  it('一张卡点开是详情弹窗，链路在里面', () => {
    const task = buildTasks([run({
      id: 'run-1',
      // 刚发生过：窗口内就该还在板上。
      at: new Date().toISOString(),
      actions: [
        { kind: 'session', mode: 'auto', ok: true, detail: '已开会话', sessionId: 's-1' },
        { kind: 'markRead', mode: 'auto', ok: true, detail: '已标记为已读' },
      ],
    })], new Set(), 15 * 60 * 1000, Date.now(), t)
    render(<BoardView face={face()} t={t} data={{ tasks: task, loaded: true, error: '' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'EXEPD-1 崩了' }))
    // 弹窗标题用的是已有的「卡片详情」键，不另造一个。
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('已标记为已读')).toBeTruthy()
  })

  it('没有任务时只说一句话，不画三个空框', () => {
    render(<BoardView face={face()} t={t} data={{ tasks: [], loaded: true, error: '' }} />)
    expect(screen.getByText(zh.boardEmpty)).toBeTruthy()
  })

  it('引擎读不到时说清是没数据，而不是空看板', () => {
    render(<BoardView face={face()} t={t} data={{ tasks: [], loaded: true, error: zh.boardMissing }} />)
    expect(screen.getByText(zh.boardMissing)).toBeTruthy()
  })
})
