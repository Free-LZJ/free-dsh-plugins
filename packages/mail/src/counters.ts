/**
 * What one mailbox action moves in the folder tree.
 *
 * The tree draws the server's own STATUS numbers rather than a count of the
 * window (see `updateMailboxCounters`), so an action the panel ran has to move
 * them by hand — and the only rows it may move them by are the ones it just
 * acted on. That is why the answer is a delta and not an absolute: the folder
 * may hold mail this window has never loaded.
 *
 * A UID is only unique inside one mailbox (RFC 3501 §2.3.1.1), so a row counts
 * only when its folder is the action's. Without that, deleting uid 5 in 垃圾邮件
 * moved a counter that belongs to INBOX's uid 5.
 *
 * @module @free-lzj/dsh-mail/counters
 */

import type { MailAction, MailSummary } from './types.ts'

/** One folder's counters, moved by an action. Both numbers are signed. */
export interface CounterMove {
  readonly folder: string
  readonly total: number
  readonly unseen: number
}

/**
 * The counters one action moves, per folder.
 *
 * Every folder that actually moves is named once; a folder whose numbers stay
 * put is left out, so a caller can read "nothing to do" off an empty answer.
 * A row the window no longer holds (it was trimmed) moves nothing: it says
 * nothing about how many unread messages the folder has.
 * @param action - the action the server accepted.
 * @param rows - the account's window, as it was *before* the action applied.
 * @returns the signed deltas to add to the tree.
 */
export function counterDeltas(action: MailAction, rows: readonly MailSummary[]): readonly CounterMove[] {
  const touched = new Set(action.uids)
  const mine = rows.filter(row => row.folder === action.folder && touched.has(row.uid))
  const unread = mine.filter(row => !row.seen).length
  const moves: CounterMove[] = []
  switch (action.op) {
    case 'delete':
      moves.push({ folder: action.folder, total: -mine.length, unseen: -unread })
      break
    case 'move':
      // The message leaves one folder and lands in the other, unseen or not.
      moves.push({ folder: action.folder, total: -mine.length, unseen: -unread })
      moves.push({ folder: action.targetFolder, total: mine.length, unseen: unread })
      break
    case 'markRead':
      moves.push({ folder: action.folder, total: 0, unseen: -unread })
      break
    case 'markUnread':
      moves.push({ folder: action.folder, total: 0, unseen: mine.length - unread })
      break
    default:
      // A star is not a count: the tree shows totals and unread, and neither moved.
      break
  }
  return moves.filter(move => move.total !== 0 || move.unseen !== 0)
}
