/**
 * The real executor: a card's run is an actual DSH session, not a scripted one.
 *
 * The board only ever sees {@link ExecutorHandle}, so "real" here means one thing:
 * a {@link SessionRunner} that the Host builds out of the harness's own services
 * (`sessionController` + `workspaceRegistry`). Keeping that behind a port is what
 * lets the whole dispatch/pause/finish chain be tested without starting an agent
 * turn — and lets a deployment without the harness services register nothing at
 * all instead of registering a broken executor.
 *
 * @module @free-lzj/dsh-console/workbench/real-session
 */

import type { Executor, ExecutorHandle, SessionSink } from './executors.ts'
import type { WorkbenchCard } from '../protocol.ts'

/** One live run, as the board drives it. */
export interface RealRun {
  readonly sessionId: string
  /** Settles when the run is over; the board maps it to the card's status. */
  readonly finished: Promise<'done' | 'failed'>
  /** Stop the run; the board calls this on end / move-out-of-processing. */
  stop(): void
}

/** The harness verbs one real run needs. */
export interface SessionRunner {
  /**
   * Create a session for one card and put the work into it.
   * @param request - the title to give the session and the prompt to run.
   * @returns the live run.
   */
  start(request: { readonly title: string; readonly prompt: string }): Promise<RealRun>
  /**
   * Add a line of guidance to a run that is already going.
   * @param sessionId - the session.
   * @param text - what the human said.
   */
  send(sessionId: string, text: string): Promise<void>
}

/** The prompt one card becomes. Kept here so a card's text and the run agree. */
export function promptFor(card: WorkbenchCard): string {
  const lines = [
    `工作台派单：${card.title}`,
    `来源：${card.source}${card.externalId === undefined ? '' : ` · ${card.externalId}`}`,
    `分类：${card.kind}（置信度 ${Math.round(card.confidence * 100)}%）`,
  ]
  if (card.body !== undefined && card.body !== '') lines.push('', card.body)
  lines.push('', '请先复述你要做什么，然后开始；完成或遇到阻碍时说明结果。')
  return lines.join('\n')
}

/**
 * An executor whose runs are real sessions.
 *
 * Pause is the honest gap: a running agent turn cannot be paused, so the handle
 * says so in the log rather than pretending. `end` and `interrupt` are real.
 */
export class RealSessionExecutor implements Executor {
  readonly id = 'session'
  readonly label = '真实会话'

  /** @param runner - the Host's session verbs. */
  constructor(private readonly runner: SessionRunner) {}

  /**
   * Start one run.
   * @param card - the card being worked.
   * @param sink - where progress goes.
   * @returns the handle the board drives.
   */
  dispatch(card: WorkbenchCard, sink: SessionSink): ExecutorHandle {
    let run: RealRun | undefined
    let stopped = false
    sink.log(`正在为「${card.title}」创建会话…`)
    void this.runner.start({ title: card.title, prompt: promptFor(card) }).then(
      async (created) => {
        run = created
        if (stopped) {
          created.stop()
          return
        }
        sink.log(`会话 ${created.sessionId} 已开始`)
        const outcome = await created.finished
        sink.log(outcome === 'done' ? '会话已结束' : '会话失败或被打断')
        sink.finish(outcome)
      },
      (error: unknown) => {
        sink.log(`创建会话失败：${error instanceof Error ? error.message : String(error)}`)
        sink.finish('failed')
      },
    )
    return {
      pause: () => { sink.log('真实会话不支持暂停：它正在跑一轮对话') },
      resume: () => { sink.log('真实会话不需要恢复') },
      end: () => {
        stopped = true
        run?.stop()
      },
      interrupt: (text) => {
        if (run === undefined) {
          sink.log('会话还没建好，这条话没送出去')
          return
        }
        void this.runner.send(run.sessionId, text).catch((error: unknown) => {
          sink.log(`插话失败：${error instanceof Error ? error.message : String(error)}`)
        })
      },
    }
  }
}
