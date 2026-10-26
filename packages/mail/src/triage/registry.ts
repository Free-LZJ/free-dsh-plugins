/**
 * 注册表：内核持有的集合，按 id 注册与取出。
 *
 * 内核里**不出现任何实现的名字**——这是 `rules/design-patterns.md` 的可机械判断
 * 检查项之一（「内核文件里出现任一实现的名字 → 违反」）。新增一种条件或动作只
 * 新增一个文件，并在装配处（`src/index.ts`）把它注册进来；这两个类一行都不用改。
 *
 * @module @free-lzj/dsh-mail/triage/registry
 */

import type { Action } from './actions/context.ts'
import type { Condition } from './conditions.ts'
import type { ActionKind, ConditionKind } from './types.ts'

/** 条件注册表：按 kind 取实现。 */
export class ConditionRegistry {
  private readonly byKind = new Map<ConditionKind, Condition>()

  /**
   * 注册一个条件实现。
   * @param condition - 实现；同 kind 重复注册会覆盖（热重载时有用）。
   */
  register(condition: Condition): void {
    this.byKind.set(condition.kind, condition)
  }

  /**
   * 取一个条件实现。
   * @param kind - 条件种类。
   * @returns 实现，或 undefined（这个部署没装这种条件）。
   */
  get(kind: ConditionKind): Condition | undefined {
    return this.byKind.get(kind)
  }

  /** 已注册的 kind，用于「部署缺哪种条件」这类提示。 */
  kinds(): readonly ConditionKind[] {
    return [...this.byKind.keys()]
  }
}

/** 动作注册表：按 kind 取实现。 */
export class ActionRegistry {
  private readonly byKind = new Map<ActionKind, Action>()

  /**
   * 注册一个动作实现。
   * @param action - 实现；同 kind 重复注册会覆盖。
   */
  register(action: Action): void {
    this.byKind.set(action.kind, action)
  }

  /**
   * 取一个动作实现。
   * @param kind - 动作种类。
   * @returns 实现，或 undefined（这个部署没装这种动作）。
   */
  get(kind: ActionKind): Action | undefined {
    return this.byKind.get(kind)
  }

  /** 已注册的 kind。 */
  kinds(): readonly ActionKind[] {
    return [...this.byKind.keys()]
  }
}

/**
 * 把一组实现注册进注册表。
 *
 * 收成函数是因为装配处要注册两批（内置 + 将来第三方提供的），写成一行比循环清楚。
 * @param registry - 目标注册表。
 * @param items - 要注册的实现。
 */
export function registerAll<T extends { readonly kind: string }>(
  registry: { register(item: T): void },
  items: readonly T[],
): void {
  for (const item of items) registry.register(item)
}
