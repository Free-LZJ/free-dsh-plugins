# @free-lzj/dsh-browser-use

用 `@` 提一个**你自己浏览器里已经开着的标签页**，然后让 agent 读它、点它、填它、上传下载、看控制台和网络。

不是新开一个干净窗口，也不是截图：BrowserSkill 的扩展跑在你原来的浏览器配置里，带着你已有的登录态和 cookie。

装这一个插件就够了——**不需要再装 `browser-skill` 技能**，它的能力、工具和操作规范都在包里。

## 它给 dsh 添两样东西

**一、`@` 菜单里的「浏览器」组**

列出你窗口里的所有标签页（当前激活的排前面，每行带站点与路径），选中插入原子提及：

```text
@[AI场景设置](dsh-browser:299872373)
```

**二、BrowserSkill 的全部工具**

以 `mcp__browser-skill__*` 前缀注册，六个工具覆盖它的完整动作集：

| 工具 | 能干什么 |
|---|---|
| `bsk_session` | 起 / 停会话，`sync` 拿当前页面的语义结构和 `context_id` |
| `bsk_page` | 导航、刷新、前进后退、等待导航或元素 |
| `bsk_inspect` | `observe` / `snapshot` / `get-html` / `console` / `network` / `extract` |
| `bsk_interact` | 点击、填表、按键、下拉、悬停、拖拽、滚轮、焦点、上传 |
| `bsk_tabs` | 列出 / 新建 / 选中 / 关闭 / 借用 / 归还标签页 |
| `bsk_assist` | 请求用户帮忙（登录、验证码、支付确认）、处理原生对话框 |

还随包注册一个 `browser-use` 技能，讲清观察层次、引用失效、借用边界、换人接手的时机——这些原本是单独的 `browser-skill` 技能在教模型的事。

## 装之前

**本机必须有 BrowserSkill 的 `bsk` 可执行文件，并且它连着你平常那个浏览器。**

```sh
bsk status      # 要能看到 browsers connected 1
```

插件不装扩展、不配浏览器；`bsk` 是它的运行时（见文末声明）。缺了 `bsk` 时插件照常加载，只是没有浏览器工具——`@` 提及和技能仍在。

**没装或连不上时，`@` 菜单不会空着**：它会显示一行「浏览器不可用」，后面跟 `bsk` 的原因和一句该做什么（`bsk --version` 确认装没装、`bsk status` 看 daemon 和浏览器连接）。插件不做任何下载或安装——`bsk` 不是独立分发的可执行文件，它是 BrowserSkill 那套东西的一部分，装法跟着它走。

## 安装

```sh
dsh plugin --profile web add @free-lzj/dsh-browser-use
```

或者从本仓库用 overlay 起一个第二实例看效果（不写进用户的 profile）：

```sh
pnpm run build
dsh --profile web --patch examples/browser-use.cordis.yml --port 0 --no-open
```

## 配置

没有配置页，只有一个环境变量：

| 名字 | 默认 | 说明 |
|---|---|---|
| `DSH_BSK_PATH` | `bsk` | `bsk` 可执行文件。机器上有多个 `bsk`（旧的全局安装）时用它点明是哪一个 |

## 怎么用

1. 输入框打 `@`，在「浏览器」里挑一行（打字同时过滤标题和 URL）。
2. 回车插入提及，然后说要干什么。
3. agent 自己 `bsk_session` 起会话、`bsk_inspect` 观察、`bsk_interact` 操作。

没 `@` 也能用：直接说"看看我浏览器里那个 Jira 页面"，它会 `bsk_tabs` 列出来再挑。

## 为什么不用官方的 browser-use provider

dsh 有一套 `ctx.browserUse` 单槽 provider 机制，官方两个实现（Chrome DevTools MCP、Playwright MCP）都走 `@deepseek-ai/dsh-experimental-browser-use-runtime` 的 `mountSessionMcp`。

那个运行时包**不随 dsh 分发**，而且它的 `dsh-scope` / `dsh-mcp-client` 依赖一旦被装进 profile 就会和 dsh 自带的那份并存，作用域标记对不上，第二个 Agent 创建会失败。所以这里直接挂 `@deepseek-ai/dsh-mcp-client`（dsh 自带），代价是**整个 Host 一个 MCP 服务器**而不是每 Session 一个：

- 好处：任何会话都能用浏览器，资源也只有一份；
- 代价：两个会话同时驱动浏览器时共用同一个 BrowserSkill 会话（同一个 Agent Window）。一个人在一个对话里干活时没有区别。

## 加一类新的可 @ 的东西

`@` 本身属于 dsh：`dsh-client-ui-input-trigger` 拥有菜单，`dsh-client-ui-reference` 往里注册了文件与对话。本包注册第二个 source，所以「加一类东西」在 Host 侧只意味着写一个 provider：

```ts
export interface MentionProvider {
  readonly id: string
  readonly label: string
  candidates(query: string, signal: AbortSignal): Promise<readonly MentionItem[]>
}
```

`src/browser-mention.ts` 是唯一的实现，`src/index.ts` 里一行 `registry.register(...)`。路由、工具、浏览器半边都不认识「浏览器」这三个字。

## 已知限制

- **`@` 分组标题只有中英两份**：将来的新 provider 没配翻译时用它在 Host 侧给的 `label`，不会空着，但也不跟界面语言切换。
- **图标借用 `session` 字形**：`ui-primitives` 里还没有专门的窗口图标。
- **不做上下文注入**：选中的标签页不会自动把内容塞进上下文，agent 得自己 `observe` 一次。
- **`bsk` 会话归 BrowserSkill 管**：插件的 `@` 侧自己维持一个常驻 bsk 会话用来列标签页，dsh 正常退出会停掉；进程被强杀时会留在 `bsk session list` 里，需要手动 `bsk session stop <id>`。
- **只列用户窗口**：agent 自己那个 Agent Window（`scope: agent`）不会出现在 `@` 里——它是工具，不是你想提的东西。

## 第三方声明

**本包不包含任何第三方源代码。** `src/` 与 `tests/` 下的代码都是为这个插件新写的；dsh 那些 `@deepseek-ai/dsh-*` 包是 peer dependency（运行时提供，未复制）。

它依赖和参考的外部东西是这些：

| 名称 | 关系 | 说明 |
|---|---|---|
| **BrowserSkill / `bsk`** | 运行时依赖，**未随包分发** | 用户本机自行安装的第三方 CLI。本包通过 `bsk mcp`（stdio）调用它，工具定义与工具描述都由它运行时提供，本包只转发。`bsk` 自身的许可需向其发布方确认，本仓库不为其授权背书 |
| `browser-skill` 技能 | 能力与操作规范的参考 | 本包的 `src/skill.ts` 是按 `bsk` 的公开 CLI 契约与这套技能的**行为规范**重写的说明文，不是其原文的复制；不随包含其文件 |
| MCP 协议 / Model Context Protocol | 协议 | 工具以标准 MCP 暴露，无代码内嵌 |
