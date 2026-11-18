// @vitest-environment jsdom
/**
 * 面板兜底：一块坏掉，不许整页变白。
 *
 * 回归点：DSH 0.2.2-rc.3 删掉了 `ui-primitives` 的一个导出，插件渲染时抛
 * `... is not a function`，宿主把整个 `main` 槽位判成 crashed —— 连侧边栏都点不动，
 * 用户手上一条线索都没有。有了边界，同样的失败只会画出一张卡片。
 *
 * @module @free-dsh-plugins/dsh-console/tests/boundary-client
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PanelBoundary, withPanelBoundary } from '../src/client/boundary.tsx'
import type { Translate } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'

/** 走真字典，缺 key 这里就会炸。 */
const t: Translate = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** 一定抛错的子树。 */
function Exploding(): never {
  throw new Error('useAnchoredPosition is not a function')
}

describe('PanelBoundary', () => {
  it('子树炸了就画卡片，而不是把整页交出去', () => {
    // React 会把错误再打一遍到 stderr；测试里静音，免得看起来像失败。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <PanelBoundary title={t('panelCrashed')} hint={t('panelCrashedHint')} reload={t('panelReload')}>
        <Exploding />
      </PanelBoundary>,
    )
    expect(container.textContent).toContain('这一页出错了')
    // 原始报错要摆出来，不然排查的人只能猜。
    expect(container.textContent).toContain('useAnchoredPosition is not a function')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
    spy.mockRestore()
  })

  it('不出错时原样交出去', () => {
    render(
      <PanelBoundary title={t('panelCrashed')} hint={t('panelCrashedHint')} reload={t('panelReload')}>
        <p>正常内容</p>
      </PanelBoundary>,
    )
    expect(screen.getByText('正常内容')).toBeTruthy()
  })

  it('withPanelBoundary 把 t 转成文案再套边界', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Guarded = withPanelBoundary(Exploding as unknown as (props: { t: Translate }) => never)
    const { container } = render(<Guarded t={t} />)
    expect(container.textContent).toContain(t('panelCrashed'))
    spy.mockRestore()
  })
})
