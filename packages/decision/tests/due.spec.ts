/**
 * Running the actions whose undo window has passed.
 *
 * The three behaviours worth pinning are the ones that would rot silently: one failing
 * action must not stop the rest, the record is patched in place rather than appended,
 * and an undo closure registered after execution makes a later undo a rollback.
 *
 * @module @free-lzj/dsh-decision/tests/due
 */

import { describe, expect, it } from 'vitest'
import { runDueActions, type DueRecord, type DueOutcome } from '../src/actions/due.ts'

interface Spec { readonly kind: string }

/** A record as the queue would hand it over. */
function record(runId: string, actionIndex: number, kind: string): DueRecord<Spec> {
  return { runId, actionIndex, action: { kind } }
}

/** A run with placeholder action results. */
function run(status = 'ok'): { status: string; actions: { ok: boolean; detail: string }[] } {
  return { status, actions: [{ ok: false, detail: '排队中' }, { ok: false, detail: '排队中' }] }
}

/** A plan over the given records, recording what it was asked to do. */
function bench(records: readonly DueRecord<Spec>[], outcomes: Record<string, DueOutcome>, runs?: Map<string, { status: string; actions: unknown[] }>) {
  const patched: { runId: string; patch: { status: string; actions: readonly unknown[] } }[] = []
  const undos: string[] = []
  const store = runs ?? new Map([['run-1', run() as { status: string; actions: unknown[] }]])
  return {
    patched,
    undos,
    store,
    plan: {
      pending: { takeDue: async () => records },
      runs: {
        get: (runId: string) => store.get(runId) as { status: string; actions: readonly unknown[] } | undefined,
        patch: async (runId: string, patch: { status: string; actions: readonly unknown[] }) => {
          patched.push({ runId, patch })
          store.set(runId, { status: patch.status, actions: [...patch.actions] })
        },
      },
      actions: {
        get: (kind: string) => (outcomes[kind] === undefined ? undefined : { run: async () => outcomes[kind] as DueOutcome }),
      },
      contextFor: (record: DueRecord<Spec>) => ({ kind: record.action.kind }),
      recordUndo: (runId: string) => undos.push(runId),
      log: () => undefined,
    },
  }
}

describe('runDueActions', () => {
  it('runs what is due and patches the matching record in place', async () => {
    const { plan, patched } = bench([record('run-1', 0, 'markRead')], {
      markRead: { ok: true, detail: '已标记' },
    })
    await expect(runDueActions(plan, new Date('2030-01-01T00:00:00Z'))).resolves.toBe(1)
    const actions = patched[0]?.patch.actions as { ok: boolean; detail: string }[]
    expect(actions[0]).toEqual({ ok: true, detail: '已标记' })
    // 第二条没被执行，仍是原来的占位——不是被删掉或覆盖。
    expect(actions[1]).toEqual({ ok: false, detail: '排队中' })
  })

  it('keeps going when one action fails', async () => {
    const { plan } = bench(
      [record('run-1', 0, 'markRead'), record('run-1', 1, 'move')],
      { markRead: { ok: false, detail: '邮箱没权限' }, move: { ok: true, detail: '已移动' } },
    )
    await expect(runDueActions(plan, new Date())).resolves.toBe(2)
  })

  it('marks the run partial when an action failed', async () => {
    const { plan, patched } = bench([record('run-1', 0, 'markRead')], {
      markRead: { ok: false, detail: '邮箱没权限' },
    })
    await runDueActions(plan, new Date())
    expect(patched[0]?.patch.status).toBe('partial')
  })

  it('never un-undoes a run that was already undone', async () => {
    const store = new Map([['run-1', { status: 'undone', actions: run('undone').actions }]])
    const { plan, patched } = bench([record('run-1', 0, 'markRead')], { markRead: { ok: true, detail: 'ok' } }, store)
    await runDueActions(plan, new Date())
    expect(patched[0]?.patch.status).toBe('undone')
  })

  it('registers the undo closure so a later undo becomes a rollback', async () => {
    const undo = async () => undefined
    const { plan, undos } = bench([record('run-1', 0, 'move')], { move: { ok: true, detail: '已移动', undo } })
    await runDueActions(plan, new Date())
    expect(undos).toEqual(['run-1'])
  })

  it('records a missing action as a failure with its kind', async () => {
    const { plan, patched } = bench([record('run-1', 0, 'nope')], {})
    await runDueActions(plan, new Date())
    const actions = patched[0]?.patch.actions as { detail: string }[]
    expect(actions[0]?.detail).toContain('nope')
  })
})
