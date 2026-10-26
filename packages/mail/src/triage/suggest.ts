/**
 * 用户点了「建议」条目上的按钮之后，真正把那件事做掉。
 *
 * 从装配里抽出来单独成函数，是因为它是**唯一一处「人批准了才执行」的路径**：写错了
 * 就意味着「用户点了执行，但什么都没发生」或者「用户点了不用，却照样执行」。这种事
 * 必须能用假宿主穷举，而不是只靠手动点一次。
 *
 * @module @free-lzj/dsh-mail/triage/suggest
 */

import type { ActionRegistry } from './registry.ts'
import type { PendingStore } from './pending.ts'
import type { RunStore } from './runs.ts'
import type { TriagePorts } from './triage.ts'

/** 处理一次建议点击需要的东西。 */
export interface SuggestDeps {
  readonly pending: PendingStore
  readonly actions: ActionRegistry
  readonly runs: RunStore
  readonly ports: TriagePorts
}

/**
 * 处理一次建议点击。
 *
 * 三条结果，都有明确含义：
 * - `apply`：真的执行那个动作；**失败就抛**，让条目留在队列里并显示原因。
 * - 其它动作 id（界面上是「不用」）：把这条建议从队列里撤掉，什么都不做。
 * - 找不到建议：抛错说明它失效了（插件重启过，或已经被处理过）。
 * @param item - 被点的条目；只读它的 id。
 * @param actionId - 动作 id。
 * @param deps - 注入的依赖。
 */
export async function applySuggestion(
  item: { readonly id: string },
  actionId: string,
  deps: SuggestDeps,
): Promise<void> {
  const found = deps.pending.findByItem(item.id)
  if (found === undefined) {
    throw new Error('这条建议已经失效了（插件重启过，或它已经被处理）')
  }
  if (actionId !== 'apply') {
    await deps.pending.cancel(found.id)
    return
  }
  const action = deps.actions.get(found.action.kind)
  if (action === undefined) throw new Error(`本部署没有实现动作 ${found.action.kind}`)
  const context = deps.ports.replayContext({
    summary: found.summary,
    accountId: found.message.accountId,
    accountName: found.message.accountId,
    ruleId: found.ruleId,
  })
  const outcome = await action.run(found.action, context)
  // 失败时**不**清队列：一件没做成的事要能留下来再试一次。
  if (!outcome.ok) throw new Error(outcome.detail)
  await deps.pending.cancel(found.id)
  // 回填那条命中记录：建议也是这次处理的一部分，只是晚了一会儿。
  const run = deps.runs.get(found.runId)
  if (run === undefined) return
  const recorded = [...run.actions]
  const previous = recorded[found.actionIndex]
  if (previous !== undefined) recorded[found.actionIndex] = { ...previous, ok: true, detail: outcome.detail }
  await deps.runs.patch(found.runId, {
    status: run.status === 'undone' ? 'undone' : 'done',
    actions: recorded,
  })
}
