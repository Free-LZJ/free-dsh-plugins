/**
 * 「打开某一封」的小信箱。
 *
 * 看板的执行流程图点到邮件节点时，要跳到邮件面板的那一封。面板本身是个 iframe
 * 文档：能决定它看哪一封的只有地址，而地址只在渲染时才算得出来。所以这里只存
 * 一个待办的 focus，`MailPanel` 订阅它、把它拼进 iframe 地址。
 *
 * @module @free-lzj/dsh-mail/client/focus
 */

/** 一封邮件的身份：账号、目录、uid。 */
export interface MailFocus {
  readonly accountId: string
  readonly folder: string
  readonly uid: string
}

/**
 * 任务 key 里带上来的那一封。
 *
 * key 是连接器给的 `mail:{账号}:{目录}:{uid}`（见 `connector.ts` 的
 * `mailKeyOf`）。这里不 import 连接器：那是 Host 半边，浏览器半边引它会把整套
 * IMAP 拖进包里。目录本身可能带冒号，所以只切头两段和末段。
 * @param key - 任务 key。
 * @returns 能定位的那一封；不是邮件的 key 就是 undefined。
 */
export function focusOfKey(key: string): MailFocus | undefined {
  const parts = key.split(':')
  if (parts.length < 4 || parts[0] !== 'mail') return undefined
  const accountId = parts[1] ?? ''
  const folder = parts.slice(2, -1).join(':')
  const uid = parts[parts.length - 1] ?? ''
  if (accountId === '' || folder === '' || !/^[1-9]\d*$/u.test(uid)) return undefined
  return { accountId, folder, uid }
}

let pending: MailFocus | undefined
const listeners = new Set<() => void>()

/** 记下要打开的那一封，面板会跟着换 iframe 地址。 */
export function focusMail(focus: MailFocus): void {
  pending = focus
  for (const listener of [...listeners]) listener()
}

/** 当前待办的 focus；没跳过就是 undefined。 */
export function currentFocus(): MailFocus | undefined {
  return pending
}

/** 订阅 focus 变化；返回退订。 */
export function subscribeFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
