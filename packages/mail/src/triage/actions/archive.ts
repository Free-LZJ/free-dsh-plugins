/**
 * 归档：移动到账号的归档文件夹。
 *
 * 不写目标文件夹时用账号自己声明的 `\Archive`（IMAP 的 special-use，QQ、Gmail、
 * Fastmail 都会声明），而不是猜一个叫 `Archive` 的路径——猜错的结果是建出一个
 * 与用户实际归档夹并存的第二个归档夹。
 *
 * @module @free-lzj/dsh-mail/triage/actions/archive
 */

import type { Action, ActionOutcome } from './context.ts'
import { failure } from './context.ts'
import { moveTo } from './move.ts'

/** 在账号的文件夹列表里找归档夹。 */
async function archiveFolderOf(context: Parameters<Action['run']>[1]): Promise<string | undefined> {
  const mail = context.mail
  if (mail === undefined) return undefined
  const boxes = await mail.listMailboxes(context.task.accountId)
  const archive = boxes.find(box => box.specialUse?.toLowerCase() === '\\archive')
  return archive?.path
}

/** 归档动作；规则写了 folder 就用它，否则用账号的 \Archive。 */
export const archiveAction: Action = {
  kind: 'archive',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    if (spec.folder !== undefined) return await moveTo(spec.folder, context, spec.folder)
    const folder = await archiveFolderOf(context)
    if (folder === undefined) {
      // 不猜路径：说不清「归档夹在哪」比建错一个夹子好。
      return failure('这个账号没有声明归档文件夹（\\Archive），请在规则里写 folder 指定一个')
    }
    return await moveTo(folder, context, '归档')
  },
}
