/**
 * 把旧的动作节点接进图里。
 *
 * 连接器现在注册的是 `ActionNode`（`run(spec, TaskContext)`），而图执行器只认
 * `FlowNode`（`run(spec, FlowContext)`）。两者说的是同一件事，差别只在「上下文怎么造」——
 * 这一层把后者翻译成前者，于是连接器**一行都不用改**。
 *
 * 这是一座临时的桥：迁移完成后 `then` 数组消失，连接器会直接产出 `FlowNode`，这个
 * 文件跟着一起删。
 *
 * @module @free-lzj/dsh-decision/flow/adapt
 */

import type { ActionSpecLike } from '../registry.ts'
import type { ActionNode } from '../task/node.ts'
import type { TaskContext } from '../task/context.ts'
import type { FlowContext, FlowNode, FlowNodeSpec, NodeResult } from './types.ts'

/**
 * 造 `TaskContext` 的能力；runner 手里有 task 与 ports，所以由它提供。
 *
 * 不传时用 {@link defaultTaskContext}：从图的上下文里就地拼出来。
 */
export type TaskContextFactory = (context: FlowContext, spec: FlowNodeSpec) => TaskContext

/**
 * 从图的上下文拼出任务上下文。
 *
 * 执行器已经把 `task` 与 `ports` 放进来了，所以这只是搬运。`vars` 用**执行期最新的**
 * `vars`（类型放宽成 string 映射），这样模板里能读到前面节点刚产出的值。
 * @param context - 图上下文。
 * @param spec - 正在跑的节点。
 * @returns 任务上下文。
 */
export const defaultTaskContext: TaskContextFactory = (context, spec) => {
  const task = context.task
  if (task === undefined) throw new Error('这一轮没有任务上下文，动作无法执行')
  return {
    task,
    event: task.event,
    vars: asTemplateVars(context.vars),
    node: { id: spec.id, kind: spec.type },
    ports: context.ports ?? {},
    now: new Date(),
    log: line => { context.log(line) },
  }
}

/** 把 `vars` 摊成模板能用的字符串映射；非字符串的值转成字符串。 */
function asTemplateVars(vars: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

/**
 * 把一个动作包成图节点。
 * @param action - 连接器注册的动作。
 * @param contextOf - 造任务上下文的回调；缺省就地拼。
 * @returns 图节点。
 */
export function actionToFlowNode(
  action: ActionNode<ActionSpecLike, TaskContext>,
  contextOf: TaskContextFactory = defaultTaskContext,
): FlowNode {
  return {
    type: action.kind,
    label: action.kind,
    group: 'action',
    sideEffect: action.sideEffect === true,
    async run(spec: FlowNodeSpec, context: FlowContext): Promise<NodeResult> {
      let taskContext: TaskContext
      try {
        taskContext = contextOf(context, spec)
      } catch (error: unknown) {
        return {
          ok: false,
          detail: `造任务上下文失败：${error instanceof Error ? error.message : String(error)}`,
          failure: 'config',
        }
      }

      const specLike = { kind: spec.type, ...(spec.config ?? {}) } as ActionSpecLike
      let outcome
      try {
        outcome = await action.run(specLike, taskContext)
      } catch (error: unknown) {
        return {
          ok: false,
          detail: `动作抛错：${error instanceof Error ? error.message : String(error)}`,
          failure: 'transient',
        }
      }

      if (outcome.ok) {
        return {
          ok: true,
          detail: outcome.detail,
          ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
          ...(outcome.undo === undefined ? {} : { undo: outcome.undo }),
          ...(outcome.data === undefined ? {} : { output: outcome.data }),
          // 动作自己声明要提前结束整条链时，转成「不走任何出边」。
          ...(outcome.status === 'stop' ? { next: [] } : {}),
        }
      }
      return {
        ok: false,
        detail: outcome.detail,
        failure: outcome.failure ?? 'transient',
        ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      }
    },
  }
}

/**
 * 批量适配。
 * @param actions - 连接器的动作。
 * @param contextOf - 造任务上下文的回调。
 * @returns 图节点列表。
 */
export function actionsToFlowNodes(
  actions: readonly ActionNode<ActionSpecLike, TaskContext>[],
  contextOf: TaskContextFactory = defaultTaskContext,
): readonly FlowNode[] {
  return actions.map(action => actionToFlowNode(action, contextOf))
}
