/**
 * 注册表：触发器与节点，都带「谁注册的」。
 *
 * 为什么必须记 owner：现在的 `ActionRegistry` 是「同 kind 静默覆盖」。装上第二个
 * 连接器之后，两个连接器各有一个 `notify` 时，后注册的会把前一个顶掉，而规则文件
 * 里那条 `notify` 从此跑的是另一家的实现——**没有报错，只有行为变了**。这是最难查
 * 的一类故障，所以这里在注册时就把冲突说清楚。
 *
 * 同一个 owner 重复注册自己 = 热重载幂等，覆盖即可。
 *
 * @module @free-lzj/dsh-decision/task/registry
 */

import type { TaskTrigger } from './event.ts'

/** 注册冲突：另一个连接器已经占了这个名字。 */
export class RegistrationConflict extends Error {
  /** `kind` 还是 `trigger`。 */
  readonly what: 'kind' | 'trigger'
  /** 撞车的名字。 */
  readonly target: string
  /** 先占住它的连接器。 */
  readonly owner: string

  constructor(what: 'kind' | 'trigger', target: string, owner: string) {
    super(`${what} "${target}" 已被连接器 "${owner}" 注册`)
    this.name = 'RegistrationConflict'
    this.what = what
    this.target = target
    this.owner = owner
  }
}

/** 按 kind 注册的节点（动作、条件都适用）。 */
export class OwnedRegistry<T extends { readonly kind: string }> {
  private readonly byKind = new Map<string, { readonly owner: string; readonly item: T }>()

  /**
   * 注册一个实现。
   * @param owner - 连接器 id。
   * @param item - 实现。
   * @throws RegistrationConflict 另一个 owner 已经用了同一个 kind。
   */
  register(owner: string, item: T): void {
    const existing = this.byKind.get(item.kind)
    if (existing !== undefined && existing.owner !== owner) {
      throw new RegistrationConflict('kind', item.kind, existing.owner)
    }
    this.byKind.set(item.kind, { owner, item })
  }

  /** @param kind - 节点 kind。@returns 实现，或 undefined。 */
  get(kind: string): T | undefined {
    return this.byKind.get(kind)?.item
  }

  /** @param kind - 节点 kind。@returns 谁注册的，或 undefined。 */
  ownerOf(kind: string): string | undefined {
    return this.byKind.get(kind)?.owner
  }

  /** @returns 已注册的 kind，按注册顺序。 */
  kinds(): readonly string[] {
    return [...this.byKind.keys()]
  }

  /** @returns 全部实现，按注册顺序。 */
  list(): readonly T[] {
    return [...this.byKind.values()].map(entry => entry.item)
  }

  /**
   * 忘掉实现。
   * @param owner - 只清这个连接器的；省略则全清。
   */
  clear(owner?: string): void {
    if (owner === undefined) {
      this.byKind.clear()
      return
    }
    for (const [kind, entry] of this.byKind) {
      if (entry.owner === owner) this.byKind.delete(kind)
    }
  }
}

/** 触发器注册表：按 id 唯一，并负责「这个事件该问谁」。 */
export class TriggerRegistry {
  private readonly byId = new Map<string, { readonly owner: string; readonly trigger: TaskTrigger; readonly seq: number }>()
  private seq = 0

  /**
   * 注册一个触发器。
   * @param owner - 连接器 id。
   * @param trigger - 触发器。
   * @throws RegistrationConflict 另一个 owner 已经用了同一个 id。
   */
  register(owner: string, trigger: TaskTrigger): void {
    const existing = this.byId.get(trigger.id)
    if (existing !== undefined && existing.owner !== owner) {
      throw new RegistrationConflict('trigger', trigger.id, existing.owner)
    }
    this.byId.set(trigger.id, {
      owner,
      trigger,
      // 缺省顺序 = 注册顺序 × 10；与规则文件的 priority 缺省同一个约定。
      seq: existing?.seq ?? this.seq++,
    })
  }

  /** @param id - 触发器 id。@returns 触发器，或 undefined。 */
  get(id: string): TaskTrigger | undefined {
    return this.byId.get(id)?.trigger
  }

  /**
   * 一个事件的候选触发器，已按 priority 升序。
   * @param type - 事件类型。
   * @returns 可能接它的触发器；空数组表示这个类型没有任何人订阅。
   */
  candidates(type: string): readonly TaskTrigger[] {
    return [...this.byId.values()]
      .filter(entry => entry.trigger.listensTo.includes(type))
      .sort((left, right) => priorityOf(left) - priorityOf(right))
      .map(entry => entry.trigger)
  }

  /** @returns 全部触发器，按注册顺序。 */
  list(): readonly TaskTrigger[] {
    return [...this.byId.values()].map(entry => entry.trigger)
  }

  /**
   * 忘掉触发器。
   * @param owner - 只清这个连接器的；省略则全清。
   */
  clear(owner?: string): void {
    if (owner === undefined) {
      this.byId.clear()
      return
    }
    for (const [id, entry] of this.byId) {
      if (entry.owner === owner) this.byId.delete(id)
    }
  }
}

/** 一个候选的排序值：显式 priority 优先，否则用它注册时的序号。 */
function priorityOf(entry: { readonly trigger: TaskTrigger; readonly seq: number }): number {
  return entry.trigger.priority ?? entry.seq * 10
}
