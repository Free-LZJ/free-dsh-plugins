/**
 * 把一个浮层贴到锚点旁边，并夹在视口里。
 *
 * **为什么不复用 `ui-primitives`**：这里原本 import 的是
 * `useAnchoredPosition`，而 DSH 0.2.2-rc.3 的 `@deepseek-ai/dsh-client-ui-primitives`
 * 里没有这个导出（实测只有 `useAnchoredMaxHeight` / `useDismissOnOutsidePointer`）。
 * 拿到的是 `undefined`，`NoticeButton` 一渲染就抛
 * `useAnchoredPosition is not a function`，把整个 `main` 槽位打崩——用户看到的就是
 * **工作台一片空白**。这块逻辑只有二十来行，自己算比赌一个不存在的导出稳。
 *
 * @module @free-dsh-plugins/dsh-console/client/anchor
 */

import { useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** 贴着锚点摆一个浮层。 */
export interface AnchoredMenuOptions {
  /** 开着才量、才定位；关着直接返回 undefined。 */
  readonly open: boolean
  /** 锚点元素（按钮）。 */
  readonly anchor: RefObject<HTMLElement | null>
  /** 浮层本身。 */
  readonly panel: RefObject<HTMLElement | null>
  /** 浮层的哪条边对齐锚点：`end` = 右对齐，`start` = 左对齐。 */
  readonly align?: 'start' | 'end'
  /** 与锚点之间的空隙。 */
  readonly gap?: number
  /** 与视口边缘至少留多少。 */
  readonly margin?: number
  /** 内容变了（条数增减会改高度）就重新夹一次。 */
  readonly signal?: unknown
}

/**
 * 算出浮层的 `position: fixed` 坐标。
 *
 * 第一次渲染返回 `undefined`：调用方据此先用「隐藏但仍占位」的样式把浮层挂上，
 * 这一帧才量得到真实宽高，下一帧才谈得上定位——不然量到的是 0×0，浮层会贴到视口
 * 右上角。
 * @param options - 锚点、浮层与边距。
 * @returns 可以交给 `style` 的坐标，或 undefined（还没量）。
 */
export function useAnchoredMenu(options: AnchoredMenuOptions): CSSProperties | undefined {
  const { open, anchor, panel, align = 'end', gap = 6, margin = 12, signal } = options
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined)
      return
    }
    const place = (): void => {
      const anchorElement = anchor.current
      const panelElement = panel.current
      if (anchorElement === null || panelElement === null) return
      const rect = anchorElement.getBoundingClientRect()
      const width = panelElement.offsetWidth
      const height = panelElement.offsetHeight
      const viewWidth = window.innerWidth
      const viewHeight = window.innerHeight

      // 默认贴在下方；下面放不开就翻到上面，再不行就贴着视口边。
      let top = rect.bottom + gap
      if (top + height + margin > viewHeight) top = Math.max(margin, rect.top - gap - height)
      // 右侧对齐（通知按钮在最右边）；左边越界就往右夹回来。
      const wanted = align === 'end' ? rect.right - width : rect.left
      const left = Math.min(Math.max(margin, wanted), Math.max(margin, viewWidth - width - margin))
      setStyle(previous =>
        previous !== undefined && previous.left === left && previous.top === top
          ? previous
          : { position: 'fixed', left, top },
      )
    }

    place()
    // 这一帧量到的可能是「刚挂上还没排版」的尺寸，再补一帧。
    const frame = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    // 捕获阶段：浮层自己的祖先滚了也要跟着挪。
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, panel, align, gap, margin, signal])

  return style
}
