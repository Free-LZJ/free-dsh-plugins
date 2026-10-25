/**
 * Executors: the agents a card can be dispatched to.
 *
 * Strategy plus registry again (`rules/design-patterns.md`): the contract
 * names no implementation, the board never names one, and the configuration
 * and the routing table pick by id. A real DSH or Codex executor is a later
 * implementation of the same interface — it spawns the agent, streams its
 * output into the sink, and answers pause/resume/end/interrupt the same way.
 *
 * What ships in v0 is a simulated executor for both built-in ids. It runs a
 * fixed, time-stepped script and never calls a model, never touches a
 * worktree, and never writes anywhere — which is what makes the board
 * testable end to end without credentials. The two ids exist so the routing
 * table, the card, and the session view already exercise the "which agent"
 * choice before any real agent is wired in.
 *
 * @module @free-lzj/dsh-console/workbench/executors
 */

import type { WorkbenchCard } from '../protocol.ts'

/** What an executor writes a session's progress into. */
export interface SessionSink {
  /** Append one log line to the session. */
  log(text: string): void
  /** Mark the session finished; the board moves the card. */
  finish(status: 'done' | 'failed'): void
}

/** The live handle a dispatch returns; the board drives the run through it. */
export interface ExecutorHandle {
  pause(): void
  resume(): void
  /** Stop the run; the board marks the session ended. */
  end(): void
  /** Deliver a follow-up message into the run. */
  interrupt(text: string): void
}

/**
 * One executor implementation.
 *
 * The interface carries no configuration: which executor runs is the routing
 * table's and the user's decision, not something an implementation reads.
 */
export interface Executor {
  /** Stable id the routing table and the card name. */
  readonly id: string
  /** Display label. */
  readonly label: string
  /**
   * Start a run for one card.
   * @param card - the card being worked.
   * @param sink - where progress goes.
   * @returns the handle the board drives.
   */
  dispatch(card: WorkbenchCard, sink: SessionSink): ExecutorHandle
}

/**
 * The registry the board consults.
 *
 * Implementations register at assembly; dispatching an id nobody registered
 * is a board-level hold with a reason, never a crash.
 */
export class ExecutorRegistry {
  private readonly executors = new Map<string, Executor>()

  /**
   * Register one implementation.
   * @param executor - the implementation.
   * @returns the unregister function.
   */
  register(executor: Executor): () => void {
    this.executors.set(executor.id, executor)
    return () => {
      if (this.executors.get(executor.id) === executor) this.executors.delete(executor.id)
    }
  }

  /** @param id - executor id. @returns the implementation, or undefined. */
  get(id: string): Executor | undefined {
    return this.executors.get(id)
  }

  /** @returns every registered implementation, in registration order. */
  list(): Executor[] {
    return [...this.executors.values()]
  }
}

/** The script a simulated run steps through; the last step finishes the run. */
const SIMULATED_STEPS: readonly string[] = [
  '开始处理，正在复现问题…',
  '已定位相关代码，正在修复…',
  '修复完成，正在自检…',
]

/**
 * A simulated executor: a time-stepped script, no model, no side effects.
 *
 * Pause stops the clock; resume continues from the step it stopped on; end
 * drops the remaining steps. The final log line states the v0 boundary
 * plainly — the result waits for a human and nothing was written back — so a
 * demo can never be mistaken for a real run.
 */
export class SimulatedExecutor implements Executor {
  /**
   * @param id - executor id (`dsh` or `codex` in v0).
   * @param label - display label.
   * @param stepDelayMs - delay between steps; tests pass 0, the board passes a visible pace.
   */
  constructor(
    readonly id: string,
    readonly label: string,
    private readonly stepDelayMs = 400,
  ) {}

  dispatch(card: WorkbenchCard, sink: SessionSink): ExecutorHandle {
    let step = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    // The handle below is a plain object, so its methods cannot read the
    // class's `this`; the delay is captured once for both the steps and it.
    const delay = this.stepDelayMs

    const runStep = (): void => {
      timer = undefined
      if (finished) return
      if (step < SIMULATED_STEPS.length) {
        sink.log(SIMULATED_STEPS[step] as string)
        step += 1
        timer = setTimeout(runStep, delay)
        timer.unref?.()
        return
      }
      finished = true
      sink.log('处理完成，结果待用户确认，未回写任何外部系统。')
      sink.finish('done')
    }

    sink.log(`模拟执行器 ${this.label} 接手「${card.title}」`)
    timer = setTimeout(runStep, delay)
    timer.unref?.()

    const clear = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    return {
      pause(): void {
        if (finished) return
        clear()
        sink.log('已暂停。')
      },
      resume(): void {
        if (finished || timer !== undefined) return
        sink.log('继续处理…')
        timer = setTimeout(runStep, delay)
        timer.unref?.()
      },
      end(): void {
        if (finished) return
        finished = true
        clear()
        sink.log('已由用户结束。')
      },
      interrupt(text: string): void {
        if (finished) return
        sink.log(`用户插话：${text}`)
        sink.log('已收到插话，继续处理…')
      },
    }
  }
}
