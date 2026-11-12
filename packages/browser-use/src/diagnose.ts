/**
 * Turning `bsk`'s own failure text into something a person can act on.
 *
 * The menu is the only place this appears, and it appears exactly when the
 * browser group is missing — so the sentence has to answer "why is this empty"
 * rather than describe an internal transport. `bsk` already writes a precise
 * diagnosis; what it does not do is say what to do about it in this context.
 *
 * @module @free-lzj/dsh-browser-use/diagnose
 */

/** One explanation: what went wrong, and the shortest thing that would fix it. */
export interface Diagnosis {
  /** The cause, in the user's terms. */
  readonly reason: string
  /** One concrete check or repair step. */
  readonly action: string
}

/** Probes worth trying for any of these failures, cheapest first. */
const CHECK_COMMAND = 'bsk --version'
const STATUS_COMMAND = 'bsk status'

/**
 * Explain one provider failure.
 * @param message - the failure text, already prefixed with the provider id.
 * @returns the cause and one next step.
 */
export function explainBsk(message: string): Diagnosis {
  const text = message.toLowerCase()
  // Not installed, or installed somewhere this process cannot see. Both are the
  // same question for the user: "is it there at all?"
  if (text.includes('enoent') || text.includes('could not start') || text.includes('not found')) {
    return {
      reason: '找不到 BrowserSkill 的 bsk 命令（没装，或不在这个进程的 PATH 里）',
      action: `在终端跑 ${CHECK_COMMAND} 确认；有多个 bsk 时用 DSH_BSK_PATH 指到对的那个`,
    }
  }
  // Installed, but it cannot own a daemon in this process tree. This is the
  // Electron Job Object case, and no amount of PATH fixing helps.
  if (text.includes('daemon') || text.includes('job object') || text.includes('breakaway')) {
    return {
      reason: 'bsk 装好了，但它起不来或连不上后台 daemon',
      action: `在终端跑 ${STATUS_COMMAND}：能连上说明是本进程受限，重启 dsh 桌面端；连不上就按 bsk 的提示处理`,
    }
  }
  // No browser attached: the CLI is fine, the extension is not.
  if (text.includes('browser') && (text.includes('connect') || text.includes('session'))) {
    return {
      reason: 'bsk 在跑，但没有浏览器连上来',
      action: `打开浏览器并确认 BrowserSkill 扩展已启用，再用 ${STATUS_COMMAND} 看 browsers connected`,
    }
  }
  return {
    reason: 'BrowserSkill 没能列出标签页',
    action: `在终端跑 ${STATUS_COMMAND} 看它的原话`,
  }
}
