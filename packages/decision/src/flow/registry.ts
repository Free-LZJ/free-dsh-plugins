/**
 * 节点类型注册表：谁能在图上出现、每种节点的配置长什么样。
 *
 * 与 `registry.ts`（条件与动作按 kind 分发）分工不同：那一层管「规则文件里一行 when/then
 * 是什么意思」，这一层管「图上一个方块是什么」。动作节点由连接器注册，控制流节点由
 * 核心自带 —— 两者在这里相遇，执行器不区分它们。
 *
 * **重名直接拒绝**，不做「后者覆盖前者」：两个插件各注册一个 `notify` 时，覆盖会让规则
 * 文件的含义随加载顺序变化，那是排查不动的一类故障。
 *
 * @module @free-lzj/dsh-decision/flow/registry
 */

import type { FlowNode } from './types.ts'

/** 一个已注册的节点类型。 */
interface Entry {
  readonly node: FlowNode
  /** 谁注册的：连接器 id，或 `'core'`。卸载时按它整块摘掉。 */
  readonly owner: string
}

/** 重名。 */
export class NodeTypeConflict extends Error {
  constructor(readonly type: string, readonly existing: string, readonly incoming: string) {
    super(`节点类型「${type}」已被「${existing}」注册，「${incoming}」不能重复占用`)
    this.name = 'NodeTypeConflict'
  }
}

/** 节点类型注册表。 */
export class FlowNodeRegistry {
  private readonly entries = new Map<string, Entry>()

  /**
   * 注册一种节点。
   * @param owner - 注册方：连接器 id，或 `'core'`。
   * @param node - 节点实现。
   * @throws {NodeTypeConflict} 同 type 已被别人占用。
   */
  register(owner: string, node: FlowNode): void {
    const existing = this.entries.get(node.type)
    if (existing !== undefined && existing.owner !== owner) {
      throw new NodeTypeConflict(node.type, existing.owner, owner)
    }
    this.entries.set(node.type, { node, owner })
  }

  /** 批量注册；中途冲突时**整块回退**，不留半个连接器。 */
  registerAll(owner: string, nodes: readonly FlowNode[]): void {
    const added: string[] = []
    try {
      for (const node of nodes) {
        this.register(owner, node)
        added.push(node.type)
      }
    } catch (error: unknown) {
      for (const type of added) this.entries.delete(type)
      throw error
    }
  }

  /** 按类型取；不认识时 undefined（解析期据此告警，运行期据此记 config 失败）。 */
  get(type: string): FlowNode | undefined {
    return this.entries.get(type)?.node
  }

  /** 是不是已经有人在用这个 type。 */
  has(type: string): boolean {
    return this.entries.has(type)
  }

  /** 全部已注册类型，按 type 排序，供 `/rules/node-types` 与面板。 */
  list(): readonly FlowNode[] {
    return [...this.entries.values()].map(entry => entry.node).sort((a, b) => a.type.localeCompare(b.type))
  }

  /** 摘掉某个注册方的全部节点（它卸载了）。 */
  clear(owner?: string): void {
    if (owner === undefined) {
      this.entries.clear()
      return
    }
    for (const [type, entry] of this.entries) {
      if (entry.owner === owner) this.entries.delete(type)
    }
  }
}
