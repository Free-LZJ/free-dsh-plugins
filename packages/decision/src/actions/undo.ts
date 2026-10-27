/**
 * Undoing one recorded run.
 *
 * The distinction this file exists to protect: **cancelling is not rolling back.**
 *
 * - A queued action still inside its window is *cancelled* — it never happened, which is
 *   the clean case.
 * - An action that already ran is *rolled back* through the closure it registered — the
 *   effect happened and is being reversed, so it can fail, and a failure is logged rather
 *   than thrown (the rest of the undo is still worth doing).
 *
 * Order matters in one direction only: rollbacks run **newest first**. Two actions on the
 * same object have to be undone in reverse, or the second undo undoes the wrong state.
 *
 * @module @free-lzj/dsh-decision/actions/undo
 */

/** What the undo pass reads from a record. */
export interface UndoRunState {
  readonly status: string
}

/** Everything an undo needs from the connector. */
export interface UndoPlan {
  readonly runs: {
    get(runId: string): UndoRunState | undefined
    patch(runId: string, patch: { readonly status: string }): Promise<unknown>
  }
  /** Queued actions for this run, so they can be taken back before they happen. */
  readonly pendingFor: (runId: string) => Promise<number> | number
  /** The rollback closures registered by actions that already ran, oldest first. */
  readonly undosFor: (runId: string) => readonly (() => Promise<unknown>)[]
  readonly log: (line: string) => void
}

/**
 * Undo one run.
 * @param runId - the record to undo.
 * @param plan - the stores, the closures, and a log line sink.
 * @returns whether anything was undone, with a sentence a human can read.
 */
export async function undoRunById(runId: string, plan: UndoPlan): Promise<{ ok: boolean; message: string }> {
  const run = plan.runs.get(runId)
  if (run === undefined) return { ok: false, message: `没有这条记录：${runId}` }
  if (run.status === 'undone') return { ok: false, message: '这条记录已经撤销过了' }

  // 还在窗口内的先取消：没发生过的动作，取消它是最干净的一种撤销。
  const cancelled = await plan.pendingFor(runId)

  const undos = plan.undosFor(runId)
  let reversed = 0
  // 逆序：同一个对象上的两个动作，正序回滚会把第二个的结果当成第一个的。
  for (const undo of [...undos].reverse()) {
    try {
      await undo()
      reversed += 1
    } catch (error: unknown) {
      plan.log(`撤销 ${runId} 时出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (cancelled === 0 && reversed === 0) {
    return { ok: false, message: '这条记录里的动作都撤不回来（例如已经建出的会话）' }
  }
  await plan.runs.patch(runId, { status: 'undone' })
  const parts: string[] = []
  if (cancelled > 0) parts.push(`取消 ${String(cancelled)} 个未执行的动作`)
  if (reversed > 0) parts.push(`回滚 ${String(reversed)} 个已执行的动作`)
  return { ok: true, message: parts.join('，') }
}
