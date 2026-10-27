/**
 * Undoing one recorded run.
 *
 * What must not blur: cancelling (the action never happened) and rolling back (it did).
 * Plus the ordering rule — rollbacks run newest first, or two actions on the same object
 * undo the wrong state.
 *
 * @module @free-lzj/dsh-decision/tests/undo
 */

import { describe, expect, it } from 'vitest'
import { undoRunById, type UndoPlan } from '../src/actions/undo.ts'

/** A plan over one run. */
function bench(options: {
  status?: string
  queued?: number
  undos?: readonly (() => Promise<unknown>)[]
  failUndo?: boolean
} = {}) {
  const patched: string[] = []
  const lines: string[] = []
  const order: string[] = []
  const undos = options.undos ?? []
  const plan: UndoPlan = {
    runs: {
      get: (runId) => (runId === 'run-1' ? { status: options.status ?? 'done' } : undefined),
      patch: async (runId, patch) => { patched.push(`${runId}:${patch.status}`) },
    },
    pendingFor: async () => options.queued ?? 0,
    undosFor: () => undos,
    log: (line) => lines.push(line),
  }
  return { plan, patched, lines, order }
}

describe('undoRunById', () => {
  it('cancels what has not run yet, and says how many', async () => {
    const { plan, patched } = bench({ queued: 2 })
    await expect(undoRunById('run-1', plan)).resolves.toEqual({ ok: true, message: '取消 2 个未执行的动作' })
    expect(patched).toEqual(['run-1:undone'])
  })

  it('rolls back what already ran, newest first', async () => {
    const order: string[] = []
    const { plan } = bench({
      undos: [
        async () => { order.push('first') },
        async () => { order.push('second') },
      ],
    })
    const result = await undoRunById('run-1', plan)
    expect(order).toEqual(['second', 'first'])
    expect(result.message).toBe('回滚 2 个已执行的动作')
  })

  it('counts only the rollbacks that worked, and logs the ones that failed', async () => {
    const lines: string[] = []
    const plan: UndoPlan = {
      runs: { get: () => ({ status: 'done' }), patch: async () => undefined },
      pendingFor: () => 0,
      undosFor: () => [
        async () => { throw new Error('邮箱不认了') },
        async () => undefined,
      ],
      log: (line) => lines.push(line),
    }
    const result = await undoRunById('run-1', plan)
    expect(result.message).toBe('回滚 1 个已执行的动作')
    expect(lines.join('\n')).toContain('邮箱不认了')
  })

  it('refuses when nothing can be undone', async () => {
    // 会话这类动作建出来就撤不回来——那比留着更糟，所以答案是「不行」而不是假装成功。
    const { plan, patched } = bench({ queued: 0, undos: [] })
    const result = await undoRunById('run-1', plan)
    expect(result.ok).toBe(false)
    expect(patched).toEqual([])
  })

  it('refuses an unknown run and an already-undone one', async () => {
    const missing = await undoRunById('nope', bench().plan)
    expect(missing.ok).toBe(false)
    const done = await undoRunById('run-1', bench({ status: 'undone' }).plan)
    expect(done.message).toContain('已经撤销过')
  })
})
