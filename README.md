<div align="center">

# free-dsh-plugins

**一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：每个包都是一个「Host + 浏览器」双面包，装一个包、声明一行，就给 dsh 添一块功能。**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm: agent-import](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg?label=agent-import)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![npm: mail](https://img.shields.io/npm/v/@free-lzj/dsh-mail.svg?label=mail)](https://www.npmjs.com/package/@free-lzj/dsh-mail)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

[English](README.en.md) · [包](#包) · [本仓库开发](#本仓库开发) · [overlay 示例](examples/agent-import.cordis.yml)

</div>

---

## 包

| 包 | 版本 | 给 dsh 添什么 |
|---|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | `0.3.2` | 把 Codex / Claude Code 已经声明好的 MCP 服务器挂进 dsh，并把各 Agent 工具的技能以**符号链接**导入 dsh 自己的技能目录统一管理；同一个包在设置页里带一页「代理配置导入」 |
| [`@free-lzj/dsh-mail`](packages/mail/README.md) | `0.1.0` | 侧边栏里的邮箱面板：读 / 搜 / 标已读 / 星标 / 移动 / 删除（**不发信**），新邮件按账号配置新建 agent 会话、投递到指定会话或只高亮 |

每个包的安装步骤、配置字段、面板细节与已知限制都在它自己的 README 里（上表链接）。下面是两个包共有的约定，以及本仓库自身的开发说明。

## 每个包都是双面包

同一个包的两半出自**同一次构建**，由包自己的 `dsh.client` 声明挂在**同一条 Loader 行**上：

| 半边 | 产物 | 跑在哪 |
|---|---|---|
| **Host** | `lib/index.js`（ESM） | Node 进程：Loader 行挂载的插件本体——长连接、路由与设置命名空间 |
| **浏览器** | `lib/client.js` | 页面：侧边栏面板或设置页那一栏，跟随 Host 的命名空间出现 |

两个包都声明了 `dsh.bundle`（补丁文件就是包目录里的 `cordis.patch.yml`），所以 `dsh plugin add`（或把包列进 profile 的 `dsh.profile.bundles`）会**自动插入那一行**。自己写 profile 时就是下面这个形状，**`id` 不能改名**——dsh 用行自身的条目 id 命名设置命名空间，页面跟随的正是它：

```yaml
- insert:
    - id: agent-import            # 邮件包是 id: mail
      name: '@free-lzj/dsh-agent-import'
```

## 安装

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
dsh plugin --profile web add @free-lzj/dsh-mail
```

**Profile 要选你实际在跑的那个**：`dsh web` 用 `web`。Electron 桌面端用 `desktop` —— 它不是另一个客户端，而是同一套 `dsh-web-app` 组合外加一份**自带版本**的 dsh 运行时，页面由 Host 自己的 `ctx.webServer` 在本机端口上提供，所以两个半边照常工作，只是 profile 与全局 CLI 不通用：

```sh
dsh plugin --profile desktop add @free-lzj/dsh-mail
```

> **加载时机**：Host 半边是启动时加载的 JS，**改了要重启** `dsh web`（桌面端预览版同理）；浏览器半边刷新页面即可。

> **兼容性预检**：两个包的 peer 范围都覆盖 0.1.7 起的 0.1.x 与含预发布在内的 0.2.x 运行时（桌面端自带的那份也在其中）。运行时不落在范围里时，dsh 启动的预检会把该行**整行禁用**（stderr 打印 `dsh: disabling profile plugin row "…": …`），插件与页面都不出现，看起来像没装上。用 `dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 对精确版本授权即可放行。

### 从本仓库安装（改插件本身时才需要）

<details>
<summary>展开</summary>

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<本仓库绝对路径>/packages/agent-import"
dsh plugin --profile web add "<本仓库绝对路径>/packages/mail"
# 或者先 pnpm pack，再装生成的 .tgz
```

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

然后把 profile 里那两条 `insert` 行删掉 `ui-settings-agent-import` 那条，只留 `id: agent-import`（内容与上面示例一致），重启 `dsh web`。设置页来自包自身的 `dsh.client` 声明，不需要再单独声明。

## 本仓库开发

pnpm monorepo，`packages/*` 一个目录就是一个包：

| 目录 | 包 |
|---|---|
| [`packages/agent-import`](packages/agent-import) | `@free-lzj/dsh-agent-import`（MCP 服务器 + 技能导入） |
| [`packages/mail`](packages/mail) | `@free-lzj/dsh-mail`（侧边栏邮箱） |

```sh
pnpm install
pnpm run typecheck   # 每个包，两个半边一起
pnpm run build       # tsc 出类型 + tsdown 出 lib/index.js（Node 半边）、lib/client.js（浏览器半边）
pnpm run test        # vitest：31 个 spec 文件 / 515 个测试
```

先 `build` 再 `test`：产物本身有契约测试（注册 id、`dsh.client` 声明、`exports["./client"]`、浏览器入口没有向 Host 半边取值），没有 `lib/` 时其中一条会显示为 skipped。

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 `windows-latest` 上跑：adapter 的 spec 断言 Windows 盘符路径（Codex / Claude Code 主目录用 `C:`、`D:` 夹具），在 Linux 上这些夹具会被当成相对路径。

浏览器半边的 spec 需要 dsh 客户端包的 Node 半边与模块表，[`vitest.config.ts`](vitest.config.ts) 与 [`packages/agent-import/tests/support/`](packages/agent-import/tests/support) 说明了这两处接线（见 [agent-import 包 README](packages/agent-import/README.md#测试如何拿到-dsh-的客户端代码)）。

真实组合的端到端测试（真装一次 dsh 启动、断言工具与技能可见）留在 dsh 主仓库里跑 —— 它依赖主仓库自带的 profile 启动夹具；本仓库的 CI 跑类型检查、构建与单元/组件测试。

### 发布

```sh
cd packages/agent-import   # 或 packages/mail
npm publish               # prepublishOnly 会先 build；--access public 写在 publishConfig 里
```

- 版本号在各包的 `package.json`；npm 上已占用的版本不能重发。
- 账号开了 auth-and-writes 2FA 时，`npm publish` 需要 OTP，或者用**勾了 Bypass 2FA 的 granular access token**：普通 token 会以 `403 … bypass 2fa enabled is required` 失败。
- npm 包页的 README 取自 tarball，发布之后再改 README 不会同步到 npm，要发一个新版本。

## License

[MIT](LICENSE)
