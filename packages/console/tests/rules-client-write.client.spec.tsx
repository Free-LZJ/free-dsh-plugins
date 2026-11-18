// @vitest-environment jsdom
/**
 * 写操作的回包不能被吞掉。
 *
 * 回归点：`write()` 以前 `return { ok: true }`，把 Host 一起交回来的 `nodeId` /
 * `edgeIndex` 全丢了。页面靠这两个 id 做「加完就选中它」「建完就打开它的条件」，于是
 * 这两件事静悄悄地从来没生效过——看起来像「点了没反应」。单测的假引擎直接返回对象，
 * 所以只有这一层能测出来。
 *
 * @module @free-dsh-plugins/dsh-console/tests/rules-client-write
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTriageSource } from '../src/client/rules.tsx'

/** 把 `fetch` 换成一个只回一次的桩。 */
function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('写操作的回包', () => {
  it('新增节点要带回 nodeId，页面才选得中它', async () => {
    stubFetch({ ok: true, nodeId: 'llm__0' })
    const source = createTriageSource()
    const result = await source.addFlowNode({ type: 'llm', flowId: 'mail-new' })
    expect(result.ok).toBe(true)
    expect((result as { nodeId?: string }).nodeId).toBe('llm__0')
  })

  it('新建规则要带回 edgeIndex，页面才打得开那条边的条件', async () => {
    stubFetch({ ok: true, nodeId: 'call-probe', edgeIndex: 3 })
    const source = createTriageSource()
    const result = await source.addRule({ flowId: 'mail-new', from: 'route', name: 'probe' })
    expect((result as { edgeIndex?: number }).edgeIndex).toBe(3)
  })

  it('拒绝时带回原因，不要把 400 当成成功', async () => {
    stubFetch({ error: '找不到节点「route」' }, 400)
    const source = createTriageSource()
    const result = await source.addFlowNode({ type: 'llm' })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('找不到节点「route」')
  })
})
