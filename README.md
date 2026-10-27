<div align="center">

# free-dsh-plugins

**一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：每个包都是一个「Host + 浏览器」双面包，装一个包、声明一行，就给 dsh 添一块功能。**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm: agent-import](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg?label=agent-import)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![npm: console](https://img.shields.io/npm/v/@free-lzj/dsh-console.svg?label=console)](https://www.npmjs.com/package/@free-lzj/dsh-console)
[![npm: mail](https://img.shields.io/npm/v/@free-lzj/dsh-mail.svg?label=mail)](https://www.npmjs.com/package/@free-lzj/dsh-mail)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

[English](README.en.md) · [包](#包) · [本仓库开发](#本仓库开发) · [overlay 示例](examples/agent-import.cordis.yml)

</div>

---

## 包

| 包 | 版本 | 给 dsh 添什么 |
|---|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | `0.3.3` | 把 Codex / Claude Code 已经声明好的 MCP 服务器挂进 dsh，并把各 Agent 工具的技能以**符号链接**导入 dsh 自己的技能目录统一管理；同一个包在设置页里带一页「代理配置导入」 |
| [`@free-lzj/dsh-console`](packages/console/README.md) | `0.2.0` | **工作台**：dsh 的首页。第一块是**注意力队列**——「现在需要我决定什么」，每条都带按钮与状态（执行 / 忽略 / 稍后），下面才是**接入它面板契约**的插件列表；再下面是**正在跑的会话**（它现在在替你干什么）。同时是**通知与条目出口**：`ctx.console.notify()` 是纯通知，`ctx.console.raise()` 是**能被处理的条目**（插件按 `kind` 注册动作处理器，点击被路由回去）。送达渠道**可替换、可多选**（桌面通知 / 应用内 / 提示音）。界面完全用 DSH 的设计系统（`ui-primitives` 控件 + `--dsw-*` token），不另起一套。另给会话里的 agent 两个工具：`console_notify` 主动通知你、`open_session` 在指定目录建工作区并开会话 |
| [`@free-lzj/dsh-decision`](packages/decision/README.md) | `0.1.0` | **库，不是插件**（不能 `dsh plugin add`）：来源无关的决策内核——命中记录与撤销窗口当下在这里，规则解析与条件/动作注册表正从 `@free-lzj/dsh-mail` 逐步搬过来。连接器依赖它，工作台读它。
| [`@free-lzj/dsh-mail`](packages/mail/README.md) | `0.3.0` | 邮箱面板：读 / 搜 / 标已读 / 星标 / 移动 / 删除（**不发信**）；同时是**邮件 I/O 提供方**（`ctx.mail`）。再带一套**规则分诊**：把新邮件按邮件头 / 正则 / 附件 / 模型判断分流到已读、移动、开会话、脚本、MCP、HTTP，带**命中记录与撤销**。装了工作台时它列在工作台里，不再单独占侧边栏 |
| [`@free-lzj/dsh-web-search-account`](packages/web-search-account/README.md) | `0.1.0` | 联网搜索用你**已登录的 DeepSeek 账号**，与对话所跑模型无关：聊天挂在网关或第三方模型上时搜索照常可用，不需要另配搜索 key |
| [`@free-lzj/dsh-worktree`](packages/worktree/README.md) | `0.5.0` | **工作树管理页**：按**仓库**分组列出全部工作树，可配置检出目录（默认 `<仓库>/.agents/worktrees`）、可开关「创建前拉取上游更新」；会话标题栏与空会话首屏各有一个入口，直接在新检出里开会话，也能进入 / 删除已有检出（**任何** Git 已注册的检出都能删，不只是本插件建的那几个）。原检出不动；布局与官方实验 bundle「Git 工作树」一致 |

每个包的安装步骤、配置字段、面板细节与已知限制都在它自己的 README 里（上表链接）。下面是这些包共有的约定，以及本仓库自身的开发说明。

## 可拔插的插件：靠契约，不靠硬依赖

`console` 定义接口，其他包接入接口，谁都不是谁的硬依赖。

| 接口 | 消费方怎么用 | 没有工作台时 |
|---|---|---|
| **面板契约** | 浏览器半边 import `@free-lzj/dsh-console/contract` 的 `useConsolePanel` | 面板保留自己的侧边栏图标与 `main` 键，和以前完全一样 |
| **通知契约** | Host 半边调用 `ctx.console?.notify({ title, body, tone, source })` | 调用变成空操作（`?.`），插件照常工作 |
| **渠道注册表** | 本包把每个送达方式注册成一个策略（`id` / `plan` / `deliver`），配置决定启用哪些 | 不适用（包内扩展点） |

契约是**打包时内联**的普通模块，所以接入包对 `console` 没有运行时依赖：没装工作台也能装上 mail 并用起来。接管与否是**运行时**判断（Loader 行顺序由用户的 profile 决定，不由本仓库决定），所以契约用 `ctx.inject` 跟随服务出现/消失——工作台可能晚于插件挂载，被禁用时也要把侧边栏图标还回去。

这种「先定义接口、再提供多个实现、最后配置多选」的写法已固化为仓库约束：[`rules/design-patterns.md`](rules/design-patterns.md)——契约、实现、注册表、配置四层分开，并给出了可机械判断的检查项。

## 搜索走账号，聊天不动

dsh 自带的搜索只在**会话本身跑在 `deepseek-account` 路由**时才借用账号凭据，一旦把聊天钉到别的 provider，搜索就退回去要一个独立 API key。`web-search-account` 把对话从这条依赖里摘出去：它直接向账号服务要一个搜索端点的令牌，用该路由认的头发出去。

`web-search-account` 自带 `dsh.bundle`，所以 `dsh plugin add` 已经插入了 `web-search-account` 那一行，profile 补丁里**不要再写**同 id 的 `- insert:`（规则见下节）；要覆盖它的配置就写一行同 id 的 override：

```yaml
- id: web
  config:
    searchProvider: deepseek-account   # 指向本插件注册的 id
- id: web-search-deepseek
  disabled: true                        # 关掉自带那个，避免两个都自称可用
- id: web-search-account                 # 无 insert：覆盖 bundle 插入的那一行
  config:
    model: deepseek-v4-flash
```

它不注册任何模型 provider、不改 `agent-default-model`，所以**只换搜索怎么被回答**，不影响谁来回复。

## 每个包都是双面包

同一个包的两半出自**同一次构建**，由包自己的 `dsh.client` 声明挂在**同一条 Loader 行**上：

| 半边 | 产物 | 跑在哪 |
|---|---|---|
| **Host** | `lib/index.js`（ESM） | Node 进程：Loader 行挂载的插件本体——长连接、路由与设置命名空间 |
| **浏览器** | `lib/client.js` | 页面：侧边栏面板或设置页那一栏，跟随 Host 的命名空间出现 |

每个包都声明了 `dsh.bundle`（补丁文件就是包目录里的 `cordis.patch.yml`），所以 `dsh plugin add`（或把包列进 profile 的 `dsh.profile.bundles`）会**自动插入那一行**。

**这样装过之后就不要再手写同 id 的 `- insert:` 行**：bundle 层已经插过一行，手写会变成同一个 id 的第二个条目，插件市场预检直接判 `duplicate loader entry id "agent-import" (2 rows)`，并把这次安装或更新整个回滚。要给这一行传配置，写一行**同 id 的 override**（无 `insert`）：

```yaml
- id: agent-import                # 邮件包是 id: mail
  config:
    sources: [codex, claude-code]
```

**`id` 不能改名**——dsh 用行自身的条目 id 命名设置命名空间，页面跟随的正是它。只有包**没进** `dsh.profile.bundles`、纯手工组织 profile，或 `dsh web --patch` overlay 场景，才写 `- insert:`（见 [`examples/agent-import.cordis.yml`](examples/agent-import.cordis.yml)）。

## 安装

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
dsh plugin --profile web add @free-lzj/dsh-console
dsh plugin --profile web add @free-lzj/dsh-mail
dsh plugin --profile web add @free-lzj/dsh-worktree
```

**Profile 要选你实际在跑的那个**：`dsh web` 用 `web`。Electron 桌面端用 `desktop` —— 它不是另一个客户端，而是同一套 `dsh-web-app` 组合外加一份**自带版本**的 dsh 运行时，页面由 Host 自己的 `ctx.webServer` 在本机端口上提供，所以两个半边照常工作，只是 profile 与全局 CLI 不通用：

```sh
dsh plugin --profile desktop add @free-lzj/dsh-console
dsh plugin --profile desktop add @free-lzj/dsh-mail
```

> **加载时机**：Host 半边是启动时加载的 JS，**改了要重启** `dsh web`（桌面端预览版同理）；浏览器半边刷新页面即可。

> **兼容性预检**：`console`、`mail`、`agent-import` 的 peer 范围覆盖 0.1.7 起的 0.1.x 与含预发布在内的 0.2.x 运行时（桌面端自带的那份也在其中）；`worktree` 用到的首屏选项位是 0.2.x 才有的，只声明 0.2.x。运行时不落在范围里时，dsh 启动的预检会把该行**整行禁用**（stderr 打印 `dsh: disabling profile plugin row "…": …`），插件与页面都不出现，看起来像没装上。用 `dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 对精确版本授权即可放行。

### 从本仓库安装（改插件本身时才需要）

<details>
<summary>展开</summary>

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<本仓库绝对路径>/packages/console"
dsh plugin --profile web add "<本仓库绝对路径>/packages/agent-import"
dsh plugin --profile web add "<本仓库绝对路径>/packages/mail"
dsh plugin --profile web add "<本仓库绝对路径>/packages/web-search-account"
dsh plugin --profile web add "<本仓库绝对路径>/packages/worktree"
# 或者先 pnpm pack，再装生成的 .tgz
```

**装本地路径时用 `.tgz` 而不是目录**：`packages/mail` 这类带第三方运行时依赖的包，`add <目录>` 会装成 `link:`，桌面端 profile 里可能整行激活失败（现象与绕过见 [`docs/troubleshooting.md`](docs/troubleshooting.md)）。`pnpm pack` 出的 tarball 走的是普通安装路径，没有这个问题。

不改 profile 也可以，用 overlay 启动即可（示例见 [`examples/agent-import.cordis.yml`](examples/agent-import.cordis.yml)）：

```sh
dsh web --patch examples/agent-import.cordis.yml
```

</details>

### 从 0.2.x 升级

`agent-import` 的 0.2.x 是两个包、两条 Loader 行（`@free-lzj/dsh-agent-import` + `@free-lzj/dsh-client-ui-settings-agent-import`）。0.3.0 把它们合成一个包，`@free-lzj/dsh-client-ui-settings-agent-import` 不再发布：

```sh
dsh plugin --profile web remove @free-lzj/dsh-client-ui-settings-agent-import
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

然后把 profile 补丁里 `ui-settings-agent-import` 那一行删掉，只留 `id: agent-import` 那一行（配置形态与上面示例一致），重启 `dsh web`。设置页来自包自身的 `dsh.client` 声明，不需要再单独声明。

## 本仓库开发

pnpm monorepo，`packages/*` 一个目录就是一个包：

| 目录 | 包 |
|---|---|
| [`packages/agent-import`](packages/agent-import) | `@free-lzj/dsh-agent-import`（MCP 服务器 + 技能导入） |
| [`packages/console`](packages/console) | `@free-lzj/dsh-console`（工作台首页 + 通知出口） |
| [`packages/mail`](packages/mail) | `@free-lzj/dsh-mail`（邮箱面板 + 邮件 I/O 服务 + 规则分诊） |
| [`packages/web-search-account`](packages/web-search-account) | `@free-lzj/dsh-web-search-account`（搜索走已登录账号，仅 Host 半边） |
| [`packages/worktree`](packages/worktree) | `@free-lzj/dsh-worktree`（工作树管理：设置 / 按仓库分组 / 新建 / 进入 / 删除） |

```sh
pnpm install
pnpm run typecheck   # 每个包，两个半边一起
pnpm run build       # tsc 出类型 + tsdown 出 lib/index.js（Node 半边）、lib/client.js（浏览器半边）
pnpm run test        # vitest：71 个 spec 文件 / 987 个测试（含 1 个 Windows 跳过项）
```

先 `build` 再 `test`：产物本身有契约测试（注册 id、`dsh.client` 声明、`exports["./client"]`、浏览器入口没有向 Host 半边取值，以及 `console` 的契约产物仍是可被内联的普通模块），没有 `lib/` 时其中一条会显示为 skipped。

**包之间有构建顺序**：`console` 的契约产物由它的构建生成，`mail` 把它内联进自己的浏览器半边。`pnpm run build` 按依赖顺序跑，整仓构建没问题；单独重建 mail 而刚改过 console 的契约时，要先把 console 建出来。

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 `windows-latest` 上跑：adapter 的 spec 断言 Windows 盘符路径（Codex / Claude Code 主目录用 `C:`、`D:` 夹具），在 Linux 上这些夹具会被当成相对路径。

浏览器半边的 spec 需要 dsh 客户端包的 Node 半边与模块表，[`vitest.config.ts`](vitest.config.ts) 与 [`packages/agent-import/tests/support/`](packages/agent-import/tests/support) 说明了这两处接线（见 [agent-import 包 README](packages/agent-import/README.md#测试如何拿到-dsh-的客户端代码)）。

真实组合的端到端测试（真装一次 dsh 启动、断言工具与技能可见）留在 dsh 主仓库里跑 —— 它依赖主仓库自带的 profile 启动夹具；本仓库的 CI 跑类型检查、构建与单元/组件测试。

### 发布

```sh
cd packages/agent-import   # 或 packages/console、packages/mail
npm publish               # prepublishOnly 会先 build；--access public 写在 publishConfig 里
```

- 版本号在各包的 `package.json`；npm 上已占用的版本不能重发。
- 账号开了 auth-and-writes 2FA 时，`npm publish` 需要 OTP，或者用**勾了 Bypass 2FA 的 granular access token**：普通 token 会以 `403 … bypass 2fa enabled is required` 失败。
- npm 包页的 README 取自 tarball，发布之后再改 README 不会同步到 npm，要发一个新版本。

## License

[MIT](LICENSE)
