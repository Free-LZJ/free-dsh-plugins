/**
 * 任务 key → 打开哪一封。
 *
 * 这条解析错了，看板上点「邮件」节点会跳到面板但停在上一封，或者干脆跳不进去。
 *
 * @module @free-lzj/dsh-mail/tests/focus
 */

import { describe, expect, it } from 'vitest'
import { focusOfKey } from '../src/client/focus.ts'

describe('任务 key 里的那一封', () => {
  it('账号、目录、uid 都拆得出来', () => {
    expect(focusOfKey('mail:acc-1:INBOX:42')).toEqual({ accountId: 'acc-1', folder: 'INBOX', uid: '42' })
  })

  it('目录里带冒号也照样拆', () => {
    expect(focusOfKey('mail:acc-1:[Gmail]:All Mail:7')).toEqual({ accountId: 'acc-1', folder: '[Gmail]:All Mail', uid: '7' })
  })

  it('不是邮件的 key、或缺了 uid 的，都不算', () => {
    expect(focusOfKey('dsh:session:s-1:2')).toBeUndefined()
    expect(focusOfKey('mail:acc-1:INBOX')).toBeUndefined()
    expect(focusOfKey('mail:acc-1:INBOX:zero')).toBeUndefined()
  })
})
