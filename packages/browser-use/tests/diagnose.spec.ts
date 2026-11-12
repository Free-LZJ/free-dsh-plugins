/**
 * `bsk` writes a precise diagnosis and no remedy. These pin the three failures a
 * person actually hits, so the menu never shows an untranslated transport error.
 */

import { describe, expect, it } from 'vitest'
import { explainBsk } from '../src/diagnose.ts'

describe('explainBsk', () => {
  it('names a missing executable', () => {
    const { reason, action } = explainBsk('browser: spawn bsk ENOENT')
    expect(reason).toContain('找不到')
    expect(action).toContain('bsk --version')
  })

  it('names the daemon that cannot start', () => {
    const { reason, action } = explainBsk(
      'browser: error: ensure daemon is running: daemon process still belongs to a Job Object after breakaway',
    )
    expect(reason).toContain('daemon')
    expect(action).toContain('bsk status')
  })

  it('separates "no browser attached" from "not installed"', () => {
    const { reason, action } = explainBsk('browser: no browser connected to this session')
    expect(reason).toContain('没有浏览器')
    expect(action).toContain('browsers connected')
  })

  it('falls back to a check rather than guessing', () => {
    const { reason, action } = explainBsk('browser: something unexpected')
    expect(reason).toContain('没能列出')
    expect(action).toContain('bsk status')
  })
})
