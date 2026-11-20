import { describe, expect, it } from 'vitest'
import { actionToFlowNode } from '../src/flow/adapt.ts'
import { defineAction } from '../src/task/node.ts'
import type { TaskContext } from '../src/task/context.ts'

/** 一个声明了字段的动作；跑不跑不重要，这里只看桥有没有把声明搬过去。 */
const action = defineAction({
  kind: 'demo',
  sideEffect: false,
  config: { text: { type: 'text', label: '正文', template: true } },
  run: async () => ({ ok: true, detail: '' }),
})

describe('动作 → 图节点', () => {
  it('配置声明原样带到面板', () => {
    const node = actionToFlowNode(action, () => ({}) as unknown as TaskContext)
    expect(node.config).toEqual({ text: { type: 'text', label: '正文', template: true } })
  })

  it('没声明就没有字段表', () => {
    const bare = defineAction({ kind: 'bare', sideEffect: false, run: async () => ({ ok: true, detail: '' }) })
    expect(actionToFlowNode(bare, () => ({}) as unknown as TaskContext).config).toBeUndefined()
  })
})
