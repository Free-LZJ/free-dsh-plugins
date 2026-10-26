/**
 * 移动到指定文件夹。
 *
 * 两件事必须按顺序：**先确保目标文件夹存在，再移动**。IMAP 的 `MOVE` 到一个不存在
 * 的邮箱会失败，而用户（或 agent）在规则里写 `folder: '推广'` 时预期的显然是「没有
 * 就建一个」。所以这里先 `ensureFolder`，它把「已存在」当作成功。
 *
 * 撤销是把邮件移回原文件夹——原文件夹就是它现在所在的那个，所以撤销闭包直接捕获
 * 了它，不需要额外查一次。
 *
 * @module @free-lzj/dsh-mail/triage/actions/move
 */

import type { Action, ActionContext, ActionOutcome } from './context.ts'
import { failure } from './context.ts'

/**
 * 移到一个文件夹，并返回可撤销的结果。
 * @param folder - 目标文件夹路径。
 * @param context - 动作上下文。
 * @param label - 结果里显示的目标名（`archive` 会换成「归档」）。
 * @returns 执行结果。
 */
export async function moveTo(folder: string, context: ActionContext, label = folder): Promise<ActionOutcome> {
  const mail = context.mail
  if (mail === undefined) return failure('未安装邮件插件（@free-lzj/dsh-mail），无法移动邮件')
  const { accountId, summary } = context.task
  // 目标就是当前文件夹时不做任何事：这多半是规则写重复了，报「已移动」会误导。
  if (summary.folder === folder) return { ok: true, detail: `已经在「${label}」里` }
  const ensured = await mail.ensureFolder(accountId, folder)
  if (!ensured.ok) return failure(`无法准备文件夹「${label}」：${ensured.message}`)
  const moved = await mail.applyAction({
    op: 'move',
    accountId,
    folder: summary.folder,
    uids: [summary.uid],
    targetFolder: ensured.path,
  })
  if (!moved.ok) return failure(`移动到「${label}」失败：${moved.message}`)
  const from = summary.folder
  return {
    ok: true,
    detail: `已移动到「${label}」`,
    undo: async () => {
      // 移回去也要确保原文件夹还在：它可能在这期间被删了。
      const back = await mail.ensureFolder(accountId, from)
      if (!back.ok) {
        context.log(`[mail 分诊] 撤销移动失败：原文件夹「${from}」不可用（${back.message}）`)
        return
      }
      const undone = await mail.applyAction({
        op: 'move',
        accountId,
        folder: ensured.path,
        uids: [summary.uid],
        targetFolder: back.path,
      })
      if (!undone.ok) context.log(`[mail 分诊] 撤销移动失败：${undone.message}`)
    },
  }
}

/** 移动到规则里写的文件夹。 */
export const moveAction: Action = {
  kind: 'move',
  sideEffect: true,
  async run(spec, context) {
    // `normalizeAction` 已经保证 `move` 一定带 folder；这里再挡一次是因为动作实现
    // 可能被别处直接调用（测试、将来的第三方装配）。
    if (spec.folder === undefined) return failure('这条 move 动作没有写目标文件夹')
    return await moveTo(spec.folder, context)
  },
}
