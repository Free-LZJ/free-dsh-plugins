// @vitest-environment jsdom
/**
 * 浮层定位：贴住锚点、别越出视口。
 *
 * 这一组是回归用例。原来这里用的是 `ui-primitives` 的 `useAnchoredPosition`，而 DSH
 * 0.2.2-rc.3 里已经没有这个导出——调用时抛 `is not a function`，把整个 `main` 槽位打崩，
 * 表现就是「工作台打开一片空白」。现在换成自己算，那这段算法就得有人看着。
 *
 * @module @free-dsh-plugins/dsh-console/tests/anchor-client
 */

import { render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { useAnchoredMenu } from '../src/client/anchor.ts'

/** 一个盒子的四条边：jsdom 不做排版，只能自己钉。 */
interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** 把元素量出来的一切都钉成指定值（jsdom 里默认全是 0）。 */
function pin(element: HTMLElement, size: { width: number; height: number }, box: Box): void {
  Object.defineProperty(element, 'offsetWidth', { configurable: true, value: size.width })
  Object.defineProperty(element, 'offsetHeight', { configurable: true, value: size.height })
  element.getBoundingClientRect = () => ({
    ...box,
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
    toJSON: () => box,
  }) as DOMRect
}

/** 一个最小宿主：一个锚点按钮 + 一个跟着它摆的面板。 */
function Harness(props: {
  readonly anchorBox: Box
  readonly panel: { readonly width: number; readonly height: number }
}): ReactNode {
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredMenu({ open: true, anchor, panel, align: 'end', gap: 6, margin: 12 })
  return (
    <div>
      <button
        ref={element => {
          anchor.current = element
          if (element !== null) pin(element, { width: 80, height: 20 }, props.anchorBox)
        }}
        type="button"
      >
        通知
      </button>
      <div
        ref={element => {
          panel.current = element
          if (element !== null) pin(element, props.panel, { left: 0, top: 0, right: 0, bottom: 0 })
        }}
        data-testid="panel"
        style={position}
      />
    </div>
  )
}

/** 面板现在拿到的坐标。 */
function positionOf(container: HTMLElement): { left: number; top: number; fixed: boolean } {
  const panel = container.querySelector('[data-testid="panel"]') as HTMLElement
  return {
    left: Number.parseFloat(panel.style.left === '' ? 'NaN' : panel.style.left),
    top: Number.parseFloat(panel.style.top === '' ? 'NaN' : panel.style.top),
    fixed: panel.style.position === 'fixed',
  }
}

describe('useAnchoredMenu', () => {
  it('贴着锚点下方、右对齐', async () => {
    const { container } = render(
      <Harness anchorBox={{ left: 700, top: 20, right: 900, bottom: 40 }} panel={{ width: 320, height: 150 }} />,
    )
    await waitFor(() => { expect(Number.isNaN(positionOf(container).left)).toBe(false) })
    const position = positionOf(container)
    // 右对齐：面板右边 = 锚点右边。
    expect(position.left).toBe(900 - 320)
    expect(position.top).toBe(40 + 6)
    expect(position.fixed).toBe(true)
  })

  it('下面是空的就翻到锚点上面去', async () => {
    // 锚点贴到视口底部，下面放不下面板。
    const box = { left: 700, top: window.innerHeight - 40, right: 900, bottom: window.innerHeight - 20 }
    const { container } = render(<Harness anchorBox={box} panel={{ width: 320, height: 200 }} />)
    await waitFor(() => { expect(Number.isNaN(positionOf(container).top)).toBe(false) })
    expect(positionOf(container).top).toBe(Math.max(12, box.top - 6 - 200))
  })

  it('右边放不下就往左夹回来，不越出视口', async () => {
    const box = { left: window.innerWidth - 40, top: 20, right: window.innerWidth - 10, bottom: 40 }
    const { container } = render(<Harness anchorBox={box} panel={{ width: 320, height: 150 }} />)
    await waitFor(() => { expect(Number.isNaN(positionOf(container).left)).toBe(false) })
    expect(positionOf(container).left).toBe(window.innerWidth - 320 - 12)
  })
})
