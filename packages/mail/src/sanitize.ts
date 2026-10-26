/**
 * 把邮件正文洗成「可以安全交给模型读的样子」。
 *
 * 这是**清洗**，不是防护的全部：真正的硬边界在别处（模型只能选标签、动作由配置文件
 * 决定）。这里只负责拿掉那些「肉眼看不见但模型看得见」的东西——它们唯一的用途就是
 * 骗过读邮件的人或模型。
 *
 * 为什么在一次纯函数里做完：它必须能被穷举测试。清洗漏掉一类字符，效果是「有一封
 * 邮件能偷偷给模型下指令」，而这种失败不会有任何报错。
 *
 * @module @free-lzj/dsh-mail/paths → 见下方导出
 */

/** 零宽字符：人看不见，但模型会把它读成内容的一部分（可用来拆散关键词绕过文本检查）。 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g

/**
 * 双向控制符（U+202A–U+202E、U+2066–U+2069）。
 *
 * 它们让一段文字**在屏幕上显示成另一种顺序**：`reversed` 之类的手法可以把恶意指令
 * 显示成人畜无害的样子，也可以把 URL 的域名部分藏起来。
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g

/** HTML 注释：正文里写着人看不见的东西，最经典的一处藏指令的位置。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g

/**
 * 靠样式藏起来的文本。
 *
 * 只做粗匹配，不解析 DOM：真按 CSS 求值就等于在插件里跑一个浏览器，而收益很小——
 * 我们要挡的是「明显想藏东西」的写法，不是完美还原渲染结果。
 */
const HIDDEN_STYLE = /<(?:span|div|p|font)[^>]*style\s*=\s*"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)[^"]*"[^>]*>[\s\S]*?<\/(?:span|div|p|font)>/gi

/** 空格与制表符拼出来的超长空白：用来把关键词挤出模型的注意力范围。 */
const LONG_BLANKS = /[ \t]{40,}/g

/** 连续空行折叠到两行以内。 */
const MANY_BREAKS = /\n{4,}/g

/**
 * 清洗一段外部文本。
 *
 * 顺序有讲究：先删注释与隐藏元素（它们整块是假的），再删零宽与双向控制符（它们是
 * 逐字符的），最后才折叠空白——反过来会把删掉之后新出现的空行漏掉。
 * @param text - 邮件正文。
 * @returns 清洗后的文本；输入为空时返回空串。
 */
export function sanitizeUntrusted(text: string): string {
  if (text === '') return ''
  return text
    .replace(HTML_COMMENT, ' ')
    .replace(HIDDEN_STYLE, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(BIDI_CONTROLS, '')
    .replace(LONG_BLANKS, '  ')
    .replace(MANY_BREAKS, '\n\n\n')
    .trim()
}

/** 交给 agent / 模型时正文的最长字符数。 */
const PROMPT_BODY_LIMIT = 4000

/**
 * 把邮件正文变成可以交给 agent 的那段文字。
 *
 * 清洗放在**这一处**：邮件正文进入会话只经过这里。放在各个调用方会在多一条路径时
 * 被漏掉，而漏掉的那条路径上，一封邮件就能给模型下指令。
 *
 * 截断也是必须的：扫描时的列表预览只是 2 KB 的原始头，而正文是完整文本；一封长邮件
 * 不截断会把每一次判定都撑大，也会把分诊会话的上下文越推越长。
 * @param text - 读回来的正文原文。
 * @param fallback - 没有正文时用的列表预览。
 * @returns 清洗、去 CR、截断后的正文。
 */
export function promptBody(text: string, fallback: string): string {
  const body = sanitizeUntrusted(text).replace(/\r\n/g, '\n').trim()
  if (body === '') return fallback
  if (body.length <= PROMPT_BODY_LIMIT) return body
  return `${body.slice(0, PROMPT_BODY_LIMIT).trimEnd()}\n…（正文过长，已截断）`
}
