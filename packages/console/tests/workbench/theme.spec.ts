// @vitest-environment jsdom
/**
 * 深浅主题探测：同一个「发光」在两种背景上要用两套配方，先得分得清背景。
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/theme
 */

import { describe, expect, it } from 'vitest'
import { luminanceOf, surfaceOf } from '../../src/client/theme.ts'

describe('亮度', () => {
  it('黑白两端', () => {
    expect(luminanceOf('rgb(0, 0, 0)')).toBe(0)
    expect(luminanceOf('rgb(255, 255, 255)')).toBe(1)
  })

  it('rgba 与空格分隔两种写法都认', () => {
    expect(luminanceOf('rgba(0, 0, 0, 0.5)')).toBe(0)
    expect(luminanceOf('rgb(255 255 255 / 20%)')).toBe(1)
  })

  it('认不出来按亮处理：默认皮肤是浅色，猜错方向宁可少发光', () => {
    expect(luminanceOf('')).toBe(1)
    expect(luminanceOf('transparent')).toBe(1)
  })
})

describe('深浅判定', () => {
  it('DSH 的两套底色各归各边', () => {
    expect(surfaceOf('rgb(247, 247, 248)')).toBe('light')
    expect(surfaceOf('rgb(28, 28, 30)')).toBe('dark')
  })

  it('中间灰偏暗，按深色算', () => {
    expect(surfaceOf('rgb(100, 100, 100)')).toBe('dark')
    expect(surfaceOf('rgb(150, 150, 150)')).toBe('light')
  })
})
