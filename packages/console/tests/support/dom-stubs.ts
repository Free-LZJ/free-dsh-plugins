/**
 * jsdom 缺的那几个浏览器全局：让 React Flow 能被渲染进测试里。
 *
 * 不是把所有浏览器 API 都补一遍——只补 jSDOM 确实没有、而 React Flow 在挂载时会
 * 直接调用的那几个。补成「什么都不做」是安全的：测试断言的是页面的结构（有几个按钮、
 * 几条提示、下拉里有几个选项），不是元素量出来多大。
 *
 * 只在需要真的画出画布的 spec 里 import 它；纯逻辑的 spec 不该受这些 stub 影响。
 *
 * @module @free-dsh-plugins/dsh-console/tests/support/dom-stubs
 */

/** 什么都不观察的 ResizeObserver：画布在 jsdom 里量不出尺寸，也不该在这里量。 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void { /* 不需要 */ }
  unobserve(): void { /* 不需要 */ }
  disconnect(): void { /* 不需要 */ }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

/**
 * `DOMMatrixReadOnly`：React Flow 用它算缩放平移。
 *
 * 只需要「读得出来、乘得下去」，不需要真的做仿射变换。
 */
if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class MatrixStub {
    readonly a: number
    readonly b: number
    readonly c: number
    readonly d: number
    readonly e: number
    readonly f: number
    constructor(init?: readonly number[]) {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = init ?? []
      this.a = a
      this.b = b
      this.c = c
      this.d = d
      this.e = e
      this.f = f
    }

    multiply(): MatrixStub { return this }
    translate(): MatrixStub { return this }
    scale(): MatrixStub { return this }
    inverse(): MatrixStub { return this }
  }
  globalThis.DOMMatrixReadOnly = MatrixStub as unknown as typeof DOMMatrixReadOnly
}
