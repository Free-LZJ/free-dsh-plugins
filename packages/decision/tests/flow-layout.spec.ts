import { describe, expect, it } from 'vitest'
import { layerOf, resolvePositions } from '../src/flow/layout.ts'
import type { Flow, FlowNodeSpec } from '../src/flow/types.ts'

/** 造一张图；`out` 用 id 列表简写。 */
function flow(specs: Readonly<Record<string, readonly string[]>>, pos: Readonly<Record<string, { x: number; y: number }>> = {}): Flow {
  const nodes: FlowNodeSpec[] = Object.entries(specs).map(([id, outs]) => ({
    id,
    type: 'x',
    ...(outs.length === 0 ? {} : { out: outs.map(to => ({ to })) }),
    ...(pos[id] === undefined ? {} : { pos: pos[id] }),
  }))
  return { id: 'f', name: 'f', connector: 'test', nodes }
}

describe('layerOf', () => {
  it('触发器在第 0 层，动作依次往下', () => {
    const layers = layerOf(flow({ a: ['b'], b: ['c'], c: [] }))
    expect([layers.get('a'), layers.get('b'), layers.get('c')]).toEqual([0, 1, 2])
  })

  it('汇合点落在最长的前驱之后，不是最短', () => {
    // a → b → d 与 a → d：d 有两个前驱，最短是 1，最长是 2。
    const layers = layerOf(flow({ a: ['b', 'd'], b: ['d'], d: [] }))
    expect(layers.get('d')).toBe(2)
  })
})

describe('resolvePositions', () => {
  it('同一张图反复算坐标一致', () => {
    const f = flow({ a: ['b', 'c'], b: [], c: [] })
    const first = resolvePositions(f)
    const second = resolvePositions(f)
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('有 pos 的节点一个像素都不动', () => {
    const pinned = { x: 999, y: 888 }
    const f = flow({ a: ['b'], b: [] }, { b: pinned })
    expect(resolvePositions(f).get('b')).toEqual(pinned)
  })

  it('新增节点不会打乱已有的人工位置', () => {
    const pinned = { x: 500, y: 300 }
    const before = flow({ a: ['b'], b: [] }, { a: pinned })
    const after = flow({ a: ['b', 'c'], b: [], c: [] }, { a: pinned })
    expect(resolvePositions(before).get('a')).toEqual(pinned)
    expect(resolvePositions(after).get('a')).toEqual(pinned)
    expect(resolvePositions(after).get('c')).toBeDefined()
  })

  it('同一层的节点横向排开、不重叠', () => {
    const f = flow({ a: ['b', 'c', 'd'], b: [], c: [], d: [] })
    const positions = resolvePositions(f)
    const b = positions.get('b')!
    const c = positions.get('c')!
    const d = positions.get('d')!
    // 同层：纵坐标相同，横坐标互不相同。
    expect(new Set([b.y, c.y, d.y]).size).toBe(1)
    expect(new Set([b.x, c.x, d.x]).size).toBe(3)
  })

  it('后一层的 y 比前一层大（自上而下）', () => {
    const positions = resolvePositions(flow({ a: ['b'], b: [] }))
    expect(positions.get('b')!.y).toBeGreaterThan(positions.get('a')!.y)
    // 单链不左右晃。
    expect(positions.get('b')!.x).toBe(positions.get('a')!.x)
  })
})
