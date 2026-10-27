/**
 * 「人批准了才执行」那条路。
 *
 * 这是整个插件里唯一一处**由人的点击**触发的执行，所以它的三种结果都必须钉死：
 * 执行成功、用户说不用、以及建议已经失效（插件重启过）。写错的后果很具体——「点了
 * 执行却没动静」或者「点了不用却照样执行」。
 *
 * @module @free-lzj/dsh-mail/tests/triage/suggest
 */

import { describe, expect, it } from 'vitest'
import { builtinActions, type ActionContext, type ActionOutcome } from '../../src/triage/actions/index.ts'
import { builtinConditions, type MatchContext } from '../../src/triage/conditions.ts'
import { ActionRegistry, ConditionRegistry, registerAll } from '@free-lzj/dsh-decision'
import { createMailPendingStore, createMailRunStore } from '../../src/triage/records.ts'
import { normalizeConfig } from '../../src/triage/config.ts'
import { applySuggestion } from '../../src/triage/suggest.ts'
import type { TriagePorts } from '../../src/triage/triage.ts'
import type { ActionKind, ActionSpec, ConditionKind, ConditionSpec, MailSummaryLike, Rule } from '../../src/triage/types.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一封邮件的摘要。 */
function summary(): MailSummaryLike {
  return {
    accountId: 'acc',
    folder: 'INBOX',
    uid: 7,
    uidValidity: 3,
    subject: '限时优惠',
    from: { address: 'news@shop.example' },
    date: '2026-10-21T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: '',
    headers: { 'list-unsubscribe': '<mailto:x@y>' },
  }
}

/** 造一套依赖，动作通过记录用的假邮件端口。 */
async function bench(options: { readonly actionFails?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mail-triage-suggest-'))
  const calls: string[] = []
  const actions = new ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind>()
  registerAll(actions, builtinActions())
  const conditions = new ConditionRegistry<ConditionSpec, MatchContext, ConditionKind>()
  registerAll(conditions, builtinConditions())
  const pending = createMailPendingStore(join(home, 'pending.json'))
  const runs = createMailRunStore(join(home, 'runs.json'))

  const context = (): ActionContext => ({
    task: {
      accountId: 'acc',
      accountName: '我的邮箱',
      summary: summary(),
      body: '',
      rule: { id: 'r1', name: '保守规则', enabled: true, priority: 0, when: [], then: [] } satisfies Rule,
    },
    vars: { repoRoot: 'D:/open' },
    templateValues: {},
    mail: {
      async listMailboxes() { return [{ path: 'INBOX' }] },
      async ensureFolder(_accountId, path) {
        calls.push(`ensureFolder:${path}`)
        return { ok: true, path }
      },
      async applyAction(action) {
        const op = (action as { op?: string }).op ?? '?'
        calls.push(`applyAction:${op}`)
        return options.actionFails === true ? { ok: false, code: 'boom', message: '服务器拒绝了' } : { ok: true, applied: 1 }
      },
    },
    log: () => undefined,
  })

  const ports: TriagePorts = {
    rules: () => [],
    config: () => normalizeConfig({ undoWindowSeconds: 0 }),
    conditions,
    actions,
    runs,
    pending,
    context,
    replayContext: () => context(),
    log: () => undefined,
  }
  await runs.load()
  await pending.load()
  return { calls, actions, pending, runs, ports, deps: { pending, actions, runs, ports } }
}

/** 排一条建议，并写一条对应的命中记录。 */
async function queueSuggestion(benchResult: Awaited<ReturnType<typeof bench>>, itemId: string) {
  const run = await benchResult.runs.append({
    at: '2026-10-21T00:00:00.000Z',
    ruleId: 'r1',
    ruleName: '保守规则',
    label: 'suggested',
    event: {
      accountId: 'acc', folder: 'INBOX', uid: 7, uidValidity: 3,
      from: 'news@shop.example', subject: '限时优惠',
    },
    actions: [{ kind: 'move', mode: 'suggest', ok: true, detail: '已建议执行 move' }],
    status: 'suggested',
  })
  await benchResult.pending.add({
    runId: run.id,
    ruleId: 'r1',
    actionIndex: 0,
    action: { kind: 'move', folder: '推广', mode: 'suggest' },
    message: run.event,
    summary: summary(),
    dueAt: '2030-01-01T00:00:00.000Z',
    kind: 'suggest',
    itemId,
  })
  return run
}

describe('applySuggestion', () => {
  it('点「执行」时真的把动作做掉，并回填命中记录', async () => {
    const b = await bench()
    const run = await queueSuggestion(b, 'item-1')

    await applySuggestion({ id: 'item-1' }, 'apply', b.deps)

    expect(b.calls).toEqual(['ensureFolder:推广', 'applyAction:move'])
    // 队列里那条建议被清掉：它已经落地了。
    expect(b.pending.list()).toHaveLength(0)
    // 命中记录跟着更新——建议也是这次处理的一部分，只是晚了一会儿。
    const updated = b.runs.get(run.id)
    expect(updated?.status).toBe('done')
    expect(updated?.actions[0]?.detail).toContain('已移动到')
  })

  it('点「不用」时只把建议撤掉，什么都不做', async () => {
    const b = await bench()
    await queueSuggestion(b, 'item-2')

    await applySuggestion({ id: 'item-2' }, 'skip', b.deps)

    expect(b.calls).toEqual([])
    expect(b.pending.list()).toHaveLength(0)
  })

  it('动作失败时抛错，而且**建议留在队列里**等着再试', async () => {
    const b = await bench({ actionFails: true })
    await queueSuggestion(b, 'item-3')

    await expect(applySuggestion({ id: 'item-3' }, 'apply', b.deps)).rejects.toThrow('服务器拒绝了')
    // 关键：一件没做成的事不能看起来像做成了。
    expect(b.pending.list()).toHaveLength(1)
  })

  it('建议已经失效（插件重启过）时抛错说清楚，而不是静默', async () => {
    const b = await bench()
    await expect(applySuggestion({ id: 'gone' }, 'apply', b.deps)).rejects.toThrow('失效')
  })

  it('本部署没有这个动作时不执行，也不清队列', async () => {
    const b = await bench()
    await queueSuggestion(b, 'item-4')
    // 把动作注册表里的 move 拿掉，模拟一个更旧的部署。
    const stripped = new ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind>()
    registerAll(stripped, builtinActions().filter(action => action.kind !== 'move'))

    await expect(
      applySuggestion({ id: 'item-4' }, 'apply', { ...b.deps, actions: stripped }),
    ).rejects.toThrow('没有实现动作 move')
    expect(b.calls).toEqual([])
    expect(b.pending.list()).toHaveLength(1)
  })
})
