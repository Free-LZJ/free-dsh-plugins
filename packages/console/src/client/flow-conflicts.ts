/**
 * 规则冲突检测：同一个分支上的两条出边会不会同时成立。
 *
 * 出边的顺序就是优先级，但界面上一排节点看不出「这两条其实在抢同一封邮件」——
 * 所以要主动算出来告诉人。
 *
 * @module @free-dsh-plugins/dsh-console/client/flow-conflicts
 */

import type { TriageFlow } from './rules.tsx'

/** 一条出边的位置。 */
export interface EdgeRef {
  readonly nodeId: string
  readonly index: number
  /** 这条边连到哪个节点。 */
  readonly to: string
}

/** 一处需要人看的冲突。 */
export interface FlowConflict {
  readonly first: EdgeRef
  readonly second: EdgeRef
  readonly kind: 'overlap' | 'unreachable'
  /** 一句话说清为什么。 */
  readonly reason: string
}

/** 条件里的取值列表（`any` / `all` / `labels`）。 */
function valuesOf(condition: Readonly<Record<string, unknown>>): string[] {
  for (const key of ['any', 'all', 'labels', 'patterns']) {
    const value = condition[key]
    if (Array.isArray(value)) return value.map(item => String(item))
  }
  return []
}

/**
 * 两条条件能不能同时成立。
 *
 * 只判**同一维度**的重叠：
 * - 两个 `from`：发件人列表有交集 → 可能同时命中
 * - 两个 `classifier`：标签集有交集 → 可能同时命中
 *
 * 不同维度（一个 `from` 一个 `classifier`）不判——它们本来就是「且」的关系，
 * 绝大多数规则也确实是跨维度的，报了只会是噪音。
 * @param left - 左边的条件。
 * @param right - 右边的条件。
 * @returns 重叠说明；不重叠时 undefined。
 */
/**
 * 两条出边能不能同时成立。
 *
 * 一组条件之间是**且**：只要有一个维度明确不重叠，整组就不可能同时命中。
 * 所以先取两边都出现的维度，逐个看取值有没有交集；任一维度没交集就判不冲突，
 * 全部维度都有交集才算冲突。
 *
 * 不同维度（一个 `from` 一个 `classifier`）本来就不冲突——它们是同一个「且」的两半。
 * @param left - 左边的条件组。
 * @param right - 右边的条件组。
 * @returns 重叠说明；不重叠时 undefined。
 */
function overlapOf(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  /** 两边都出现的条件种类。 */
  const shared: string[] = []
  for (const condition of left) {
    const kind = typeof condition['kind'] === 'string' ? condition['kind'] : ''
    if (kind === '' || shared.includes(kind)) continue
    if (right.some(other => other['kind'] === kind)) shared.push(kind)
  }
  if (shared.length === 0) return undefined

  const reasons: string[] = []
  for (const kind of shared) {
    const mine = left.filter(item => item['kind'] === kind).flatMap(valuesOf)
    const theirs = right.filter(item => item['kind'] === kind).flatMap(valuesOf)
    // 没有取值列表（比如正则）就判不了，跳过这一维度。
    if (mine.length === 0 || theirs.length === 0) continue
    const common = mine.filter(value => theirs.includes(value))
    // 这个维度是**且**的一半，没交集就整组不可能同时命中。
    if (common.length === 0) return undefined
    reasons.push(`${kind} 都有 ${common.slice(0, 3).join(', ')}`)
  }
  return reasons.length === 0 ? undefined : reasons.join('；')
}

/**
 * 找出图里的冲突。
 * @param flow - 要检查的图。
 * @returns 冲突列表；没有就是空数组。
 */
export function detectConflicts(flow: TriageFlow): FlowConflict[] {
  const found: FlowConflict[] = []
  for (const node of flow.nodes) {
    const out = node.out ?? []
    if (out.length < 2) continue

    for (let i = 0; i < out.length; i += 1) {
      const first = out[i]
      if (first === undefined) continue
      const leftWhen = first.when ?? []

      // 无条件边（兜底）后面还有边：后面那些永远不会命中——不管它们有没有条件。
      if (leftWhen.length === 0 && i < out.length - 1) {
        found.push({
          first: { nodeId: node.id, index: i, to: first.to },
          second: { nodeId: node.id, index: i + 1, to: out[i + 1]?.to ?? '' },
          kind: 'unreachable',
          reason: `第 ${String(i + 1)} 条是无条件兜底，它后面还有 ${String(out.length - 1 - i)} 条，永远不会命中`,
        })
        break
      }


      for (let j = i + 1; j < out.length; j += 1) {
        const later = out[j]
        if (later === undefined) continue
        const overlap = overlapOf(leftWhen, later.when ?? [])
        if (overlap === undefined) continue
        found.push({
          first: { nodeId: node.id, index: i, to: first.to },
          second: { nodeId: node.id, index: j, to: later.to },
          kind: 'overlap',
          reason: `第 ${String(i + 1)} 条和第 ${String(j + 1)} 条可能同时命中（${overlap}），靠前的先赢`,
        })
      }
    }
  }
  return found
}
