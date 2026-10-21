/**
 * What one action moves in the folder tree.
 *
 * The rail draws the server's own counts, so an edit the panel makes has to move
 * them by hand. Getting that wrong is not cosmetic: 垃圾邮件 is listed but never
 * scanned, so a delete that moved nothing left "1 未读" on the rail for the rest
 * of the session.
 *
 * @module @free-lzj/dsh-mail/tests/counters
 */

import { describe, expect, it } from 'vitest'
import { counterDeltas } from '../src/counters.ts'
import type { MailAction, MailSummary } from '../src/types.ts'

/** One list row, shaped the way a scan produces them. */
function row(over: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 'acc-1',
    folder: '垃圾邮件',
    uid: 5,
    uidValidity: 7,
    subject: '免费领取',
    from: { address: 'spam@example.com' },
    date: '2026-08-12T08:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    snippet: '',
    headers: {},
    ...over,
  }
}

describe('the counters one action moves', () => {
  it('takes the deleted rows out of the total and the unread count', () => {
    const action: MailAction = { op: 'delete', accountId: 'acc-1', folder: '垃圾邮件', uids: [5, 6] }
    expect(counterDeltas(action, [row(), row({ uid: 6, seen: true })])).toEqual([
      { folder: '垃圾邮件', total: -2, unseen: -1 },
    ])
  })

  it('moves nothing for a folder the action did not name, even at the same UID', () => {
    // UIDs are per-mailbox (RFC 3501 §2.3.1.1): INBOX's uid 5 is not the deleted
    // uid 5, and the row that leaves the window is the one that moves the numbers.
    const action: MailAction = { op: 'delete', accountId: 'acc-1', folder: '垃圾邮件', uids: [5] }
    expect(counterDeltas(action, [row({ folder: 'INBOX' })])).toEqual([])
    // A UID the window no longer holds (it was trimmed) says nothing about how
    // many unread messages the folder has, so it moves nothing either.
    expect(counterDeltas(action, [row({ uid: 9 })])).toEqual([])
  })

  it('hands a moved row from one folder to the other, unread as it is', () => {
    const action: MailAction = {
      op: 'move', accountId: 'acc-1', folder: '垃圾邮件', uids: [5], targetFolder: '收件箱',
    }
    expect(counterDeltas(action, [row()])).toEqual([
      { folder: '垃圾邮件', total: -1, unseen: -1 },
      { folder: '收件箱', total: 1, unseen: 1 },
    ])
  })

  it('moves only the unread count when the action is about reading', () => {
    const read: MailAction = { op: 'markRead', accountId: 'acc-1', folder: '垃圾邮件', uids: [5, 6] }
    const rows = [row(), row({ uid: 6, seen: true })]
    expect(counterDeltas(read, rows)).toEqual([{ folder: '垃圾邮件', total: 0, unseen: -1 }])
    // The reverse flips the rows that were read, and a row already unread is not
    // counted twice.
    expect(counterDeltas({ ...read, op: 'markUnread' }, rows)).toEqual([{ folder: '垃圾邮件', total: 0, unseen: 1 }])
    // Nothing to move is said as nothing to move.
    expect(counterDeltas(read, [row({ seen: true })])).toEqual([])
  })

  it('moves nothing for a star, which is not a count', () => {
    const action: MailAction = { op: 'flag', accountId: 'acc-1', folder: '垃圾邮件', uids: [5] }
    expect(counterDeltas(action, [row()])).toEqual([])
    expect(counterDeltas({ ...action, op: 'unflag' }, [row({ flagged: true })])).toEqual([])
  })
})
