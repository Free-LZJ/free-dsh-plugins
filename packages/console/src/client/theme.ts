/**
 * 深浅主题探测：判断画布底下是深色还是浅色。
 *
 * **为什么要探测**：插件拿不到主题 API——`primitives` 不导 theme，页面根节点没有
 * `data-theme`，`prefers-color-scheme` 只反映系统偏好、不反映用户在 DSH 里挑的皮肤。
 * 唯一可靠的办法是**问渲染结果**：放一个用 `--dsw-alias-bg-layer-1` 上色的探针元素，
 * 读它算出来的背景色，按亮度判深浅。
 *
 * **为什么非分不可**：同样一句「发光」，深色背景要宽而柔的光晕（低透明度、大扩散），
 * 浅色背景要紧描边 + 短投影（高透明度、小扩散）。一套配方喂两个背景，不是糊成一团
 * 就是根本看不见。
 *
 * @module @free-dsh-plugins/dsh-console/client/theme
 */

import { useSyncExternalStore } from 'react'

/** 画布底下是哪一类背景。 */
export type Surface = 'dark' | 'light'

/**
 * 相对亮度，0（黑）~1（白）。
 *
 * 认不出来的颜色（`transparent`、空串、jsdom 里的空值）按「亮」处理：默认皮肤是浅色，
 * 猜错方向时宁可少发光，也别在浅色背景上糊一片。
 * @param color - `getComputedStyle` 拿到的 `rgb()/rgba()` 串。
 * @returns 0~1 的亮度。
 */
export function luminanceOf(color: string): number {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/u.exec(color)
  if (match === null) return 1
  const r = Number(match[1])
  const g = Number(match[2])
  const b = Number(match[3])
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/** 背景色 → 深浅。分界取 0.5：`#f7f7f8`(≈0.96) 是浅、`#1c1c1e`(≈0.11) 是深。 */
export function surfaceOf(color: string): Surface {
  return luminanceOf(color) < 0.5 ? 'dark' : 'light'
}

/** 真去浏览器里量一次。 */
function probe(): Surface {
  if (typeof document === 'undefined' || document.body === null) return 'light'
  const element = document.createElement('div')
  element.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-layer-1)'
  document.body.appendChild(element)
  const color = getComputedStyle(element).backgroundColor
  element.remove()
  return surfaceOf(color)
}

let current: Surface | undefined
const listeners = new Set<() => void>()
let unwatch: (() => void) | undefined
let frame = 0

function refresh(): void {
  const next = probe()
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

/** 一次 rAF 内的多次 DOM 变动合并成一次探测。 */
function schedule(): void {
  if (frame !== 0) return
  if (typeof requestAnimationFrame !== 'function') {
    refresh()
    return
  }
  frame = requestAnimationFrame(() => {
    frame = 0
    refresh()
  })
}

/**
 * 盯着换肤的两种可能落点：`<html>` 上的 class/style，和 `<head>` 里换掉的那份 CSS 变量。
 * 两种都不是就走不到——所以 `matchMedia` 也接上，至少系统主题变了能跟上。
 */
function watch(): () => void {
  const dispose: (() => void)[] = []
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => { schedule() })
    observer.observe(document.documentElement, { attributes: true })
    if (document.head !== null) {
      observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    }
    dispose.push(() => { observer.disconnect() })
  }
  if (typeof matchMedia === 'function') {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => { schedule() }
    media.addEventListener('change', onChange)
    dispose.push(() => { media.removeEventListener('change', onChange) })
  }
  return () => { for (const fn of dispose) fn() }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    current = probe()
    unwatch = watch()
    // 首次拿到令牌时皮肤可能还没应用完，补一拍。
    schedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unwatch?.()
      unwatch = undefined
    }
  }
}

/** 当前画布的深浅。服务端渲染（jsdom）一律当浅色。 */
export function useSurface(): Surface {
  return useSyncExternalStore(subscribe, () => (current ??= probe()), () => 'light')
}
