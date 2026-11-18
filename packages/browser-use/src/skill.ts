/**
 * The browser skill, shipped inside the plugin.
 *
 * BrowserSkill's own MCP server already delivers a one-paragraph workflow in its
 * `initialize` instructions, but that text is a reminder, not a procedure: it
 * cannot say when to stop, what to do when refs go stale, or where the boundary
 * between the user's tabs and ours sits. Those rules live here so installing
 * this plugin is enough — the separate `browser-skill` agent skill is not needed.
 *
 * The body is written for this plugin against BrowserSkill's public CLI
 * contract; it is not a copy of upstream skill text.
 *
 * @module @free-lzj/dsh-browser-use/skill
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Kebab-case skill id; also the name the model calls. */
export const SKILL_NAME = 'browser-use'

/**
 * The instruction body.
 *
 * Short on purpose: every token here is paid on each use, and the MCP tools
 * carry their own schemas. It states the loop, the two boundaries that actually
 * bite (borrowed tabs, stale refs), and when to hand control back to the person.
 */
const CONTENT = `# 操作用户自己的浏览器

你驱动的是**用户那个已经登录的浏览器**（Chrome 或 Edge），不是无痕窗口。它带着用户真实的 cookie 和登录态——所以你不必、也不应该去登录任何东西。

## 先看有哪些工具

工具前缀 \`mcp__browser-skill__\`，按域分成六个：

- \`bsk_session\` — \`start\` / \`stop\` / \`sync\`
- \`bsk_page\` — \`navigate\` / \`reload\` / 前进后退 / 等待导航或元素
- \`bsk_inspect\` — \`observe\` / \`snapshot\` / \`get-html\` / \`console\` / \`network\` / \`extract\`
- \`bsk_interact\` — 点击、输入、按键、下拉、悬停、拖拽、滚轮、焦点、上传
- \`bsk_tabs\` — 列出 / 新建 / 选中 / 关闭 / 借用 / 归还
- \`bsk_assist\` — 请求用户帮忙、处理原生对话框

每个工具的 \`action\` 参数决定具体动作，其余参数在工具 schema 里。

## 一个任务的样子

用户用 \`@\` 提到了一个标签页时，mention 长这样：

    @[标题](dsh-browser:<tabId>#<sessionId>)

\`#\` 前是标签页 id，\`#\` 后是插件已经起好的会话 id。

1. 直接 \`bsk_tabs\` 用 \`borrow\` 借它：\`{ action: "borrow", tab_id: <tabId>, session: <sessionId> }\`。
   **不要 \`bsk_session start\`**——那会再开一个会话，正是要避免的。borrow 是就地接管：页面留在用户原来的窗口和位置，不搬走、不新开页面。
2. \`bsk_session\` 的 \`sync\`（带同一个 \`session\`）拿当前页面的语义结构（VOM 文本，控件带 \`@eN\` 引用）和 \`context_id\`。
3. 要操作控件时，\`bsk_interact\` 用最新一次观察里的 \`@eN\`，并把 \`context_id\` 一起带上——协作保护要求"这次动作基于哪次观察"。
4. 每次有意义的页面变化后重新 \`sync\`，再继续。
5. **目标达成即 \`bsk_session\` \`stop\`**。别指望空闲超时替你收尾；停掉会话就放开借来的标签页，页面留在原处。

没有 \`@\` 的提及（比如用户只说"看看我浏览器里那个页面"）才用 \`bsk_session\` 的 \`start\`，再用 \`bsk_tabs\` 的 \`list\` 找页面。

## 观察的层次

默认用 \`observe\`（语义结构，够日常交互）。不够时按这个顺序升级，不要一上来就抓 HTML：

1. \`observe\` — 常规理解页面
2. \`observe\` 带 \`probe-hover\` — 该出现却没出现的控件，通常是 hover 才显形的菜单
3. \`snapshot\` — 需要更严格的无障碍树时
4. \`get-html\` — 精确标记或隐藏元数据
5. \`console\` / \`network\` — 调试证据，只读
6. \`extract\` — 已加载的表格/列表，带列定义
7. \`screenshot\` — 只有布局、样式、canvas、图片这类观察文本表达不了的东西才用它

## 两个会咬人的边界

**用户标签页**：\`borrow\` 是就近接管——页面留在用户的窗口里，不搬走、不复制。它归我们控制，用户仍然看得见、也能同时操作，所以别在一次不相关的任务里一直占着它。别凭空编 tab id。\`scope: agent\` 只代表"我们正在控制"，不是另一个窗口。

**引用会失效**：导航、重新渲染、大面积 DOM 变化都会让 \`@eN\` 作废。拿不准就重新 \`sync\` 一次——这比猜一个旧引用去点错地方便宜得多。

## 需要人来做的事

登录、验证码、短信码、支付确认、第三方授权——这些不该由你硬试。用 \`bsk_assist\` 的 \`request_help\` 把请求和页面位置说清楚，等用户做完再继续。连试两次没有进展就转人工，不要反复重放同一个失败动作。

## 失败时怎么走

- 引用失效：重新 \`sync\`，重试一次原动作。
- 找不到控件：先确认是不是 hover 才显形，再降级到 \`snapshot\` 或 \`get-html\`。
- 超时：先看当前页面状态，再决定要不要等更久；不要连续加长超时。
- 输入框的值和你要的不一样（页面做了格式化）：看实际值是否可接受，别盲目重填。
- 无法恢复：说清卡在哪，然后 \`stop\` 会话。

## 不要做的事

- 不要把 cookie、token、密码从页面里读出来。
- 不要在用户没要求时操作他的标签页。
- 不要在任务结束后留着会话和借用的标签页。`

/** The skill this plugin registers, so a separate skill install is unnecessary. */
export const BROWSER_SKILL: SkillRegistration = {
  name: SKILL_NAME,
  description: '操作用户已登录的真实浏览器（Chrome / Edge）：打开页面、读页面、点填、多标签、上传下载、控制台与网络诊断。用 @ 提及用户开着的标签页，或用 bsk_tabs 浏览。',
  whenToUse: '用户要你去看一个网页、在他开着的浏览器里操作（登录态已就绪）、复现页面问题、抓取页面数据、验证部署页面，或 @ 了一个标签页时。需要新建独立浏览器、无登录态或纯本地 HTML 渲染时不要用。',
  content: CONTENT,
  source: 'bundled',
}
