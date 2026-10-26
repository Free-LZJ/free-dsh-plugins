/**
 * 从邮件头里认出「这是哪个仓库」。
 *
 * 这是整套设计里唯一一处把「邮件」变成「工作目录」的地方，而它能做成确定性规则是
 * 有实证的：真实 GitHub 通知里带着
 *
 * ```text
 * List-Id: Free-LZJ/free-dsh-plugins <free-dsh-plugins.Free-LZJ.github.com>
 * ```
 *
 * 仓库全名直接可读，所以 `workspaceTemplate: 'D:/open/{repo}'` 不需要任何模型参与。
 * 抽成模块是因为它会被 `session` 动作与设置页的「为什么命中」解释共用。
 *
 * @module @free-lzj/dsh-mail/triage/repo
 */

/**
 * 从 `list-id` 里取出仓库名（`/` 后的那一段）。
 *
 * 三种形态都要认，因为不同的邮件系统写出来的不一样：
 * `Owner/Repo <repo.owner.github.com>`（GitHub 原样）、`Owner/Repo`（裸值）、
 * 以及带引号的折行形式。取不到就返回 undefined——**不要退化成空串**：用一个空
 * 目录去建会话比不建更糟，调用方据此把动作判为失败。
 * @param headers - 邮件头（键小写）。
 * @returns 仓库名（不含 owner），或 undefined。
 */
export function repoFromListId(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = headers['list-id']
  if (raw === undefined) return undefined
  // 去掉尖括号里那一段（`<repo.owner.github.com>`）与引号，只留下 `Owner/Repo` 部分。
  const outside = raw.replace(/<[^>]*>/g, ' ').replaceAll('"', ' ').trim()
  const candidate = outside.split(/\s+/).find(part => part.includes('/'))
  if (candidate === undefined) return undefined
  const [, repo] = candidate.split('/')
  const name = repo?.trim()
  return name === undefined || name === '' ? undefined : name
}

/**
 * 从 `list-id` 里取出仓库全名（`Owner/Repo`）。
 *
 * 与 {@link repoFromListId} 分开，是因为「落到哪个目录」用仓库名，「这条通知属于
 * 谁」用全名——会话标题里写全名更能说明白。
 * @param headers - 邮件头（键小写）。
 * @returns `Owner/Repo`，或 undefined。
 */
export function fullNameFromListId(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = headers['list-id']
  if (raw === undefined) return undefined
  const outside = raw.replace(/<[^>]*>/g, ' ').replaceAll('"', ' ').trim()
  const candidate = outside.split(/\s+/).find(part => part.includes('/'))
  return candidate === undefined ? undefined : candidate.trim()
}

/**
 * 把模板里的占位符换掉。
 *
 * 支持 `{repo}`、`{owner}`、`{subject}`、`{date}`、`{account}`。**不支持从正文取值**：
 * 模板会变成文件系统路径或命令行参数，让不可信正文参与进去等于把注入口送到那里。
 * @param template - 带占位符的模板。
 * @param values - 可替换的值。
 * @returns 替换后的文本；认不出的占位符原样保留（写错要看得见）。
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string | undefined>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}
