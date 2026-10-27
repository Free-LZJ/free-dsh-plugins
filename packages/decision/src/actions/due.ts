/**
 * Running the actions whose undo window has passed.
 *
 * This is the other half of the undo window: a queued `undo` action is cancelled while
 * the window is open, and what is still queued when it closes happens for real here.
 *
 * Three judgements live in this file, and they are why it is worth having one copy:
 *
 * 1. **Each action runs on its own, and records its own result.** One failure does not
 *    stop the rest — IMAP actions were never transactional, and stopping at the first
 *    failure would leave the queue half-done with no record of where it stopped.
 * 2. **An undo closure is registered back after execution.** So "undo" after the window
 *    is a *rollback*, not a cancellation — the action already happened.
 * 3. **The record is patched in place, not appended.** A record says "how this item was
 *    handled"; running twenty seconds later is the same handling, not a second one.
 *
 * What the kernel does not know: what a pending record carries besides its action, and
 * how to build a context from it. Both arrive from the connector.
 *
 * @module @free-lzj/dsh-decision/actions/due
 */

/** The record fields this runner reads. */
export interface DueRecord<TSpec> {
  readonly runId: string
  /** Position in the run's action list, so the result lands on the right one. */
  readonly actionIndex: number
  readonly action: TSpec & { readonly kind: string }
}

/** The run fields this runner reads and writes. */
export interface DueRun {
  readonly status: string
  readonly actions: readonly unknown[]
}

/** What one action answers with. */
export interface DueOutcome {
  readonly ok: boolean
  readonly detail: string
  /** Registered so a later undo is a rollback rather than a cancellation. */
  readonly undo?: () => Promise<void>
}

/** Everything a due pass needs from the connector. */
export interface DuePlan<TRecord extends DueRecord<TSpec>, TSpec, TContext> {
  readonly pending: { takeDue(now: Date): Promise<readonly TRecord[]> }
  readonly runs: {
    get(runId: string): DueRun | undefined
    /** Patch a run in place; the store's own patch signature is wider, so it accepts this. */
    patch(runId: string, patch: { readonly status: string; readonly actions: readonly unknown[] }): Promise<unknown>
  }
  readonly actions: {
    get(kind: string): { run(spec: TSpec, context: TContext): Promise<DueOutcome> } | undefined
  }
  /** Build the action context for one queued record. */
  readonly contextFor: (record: TRecord) => TContext
  /** Remember a closure so `undoRun` can roll this action back later. */
  readonly recordUndo: (runId: string, undo: () => Promise<void>) => void
  readonly log: (line: string) => void
}

/**
 * Run every action that is due.
 * @param plan - the queue, the runs, the actions, and the context builder.
 * @param now - the moment the window is compared against; tests pin it.
 * @returns how many actions were attempted.
 */
export async function runDueActions<
  TRecord extends DueRecord<TSpec>,
  TSpec,
  TContext,
>(plan: DuePlan<TRecord, TSpec, TContext>, now: Date): Promise<number> {
  const due = await plan.pending.takeDue(now)
  let executed = 0
  for (const record of due) {
    const action = plan.actions.get(record.action.kind)
    const context = plan.contextFor(record)
    let ok: boolean
    let detail: string
    if (action === undefined) {
      ok = false
      detail = `本部署没有实现动作 ${record.action.kind}`
    } else {
      try {
        const outcome = await action.run(record.action, context)
        ok = outcome.ok
        detail = outcome.detail
        if (outcome.undo !== undefined) plan.recordUndo(record.runId, outcome.undo)
      } catch (error: unknown) {
        ok = false
        detail = `执行失败：${error instanceof Error ? error.message : String(error)}`
        plan.log(`动作 ${record.action.kind} 执行失败：${detail}`)
      }
    }
    executed += 1
    const run = plan.runs.get(record.runId)
    if (run === undefined) continue
    const actions = [...run.actions]
    const previous = actions[record.actionIndex]
    if (previous !== undefined) actions[record.actionIndex] = { ...(previous as object), ok, detail }
    await plan.runs.patch(record.runId, {
      status: run.status === 'undone' ? 'undone' : ok ? run.status : 'partial',
      actions,
    })
  }
  return executed
}
