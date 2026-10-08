<div align="center">

# free-dsh-plugins

**把 Codex / Claude Code 已经声明好的 MCP 服务器接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh），并把各 Agent 工具的技能以符号链接导入 dsh 自己的技能目录统一管理。**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4f46e5.svg)](packages/agent-import/README.md)

[English](README.en.md) · [npm](https://www.npmjs.com/package/@free-lzj/dsh-agent-import) · [包文档](packages/agent-import/README.md) · [示例 overlay](examples/agent-import.cordis.yml)

</div>

---

> 同一台机器上同时用 dsh 和别的 Agent 工具时，MCP 服务器与技能只需要声明一次。插件在激活时读另一侧的声明：服务器挂到 dsh 的 `mcp-client` 上，技能则以**符号链接**（Windows 用 junction，免管理员权限）进入 dsh 自己的技能目录——不复制文件，所以改一处两边同步，移除导入也只删链接、源文件不动。设置页提供一页，用来看这次导入实际挂载了什么、用每行一个开关启停单项技能、以及按来源调整导入范围。

## 仓库里有什么

| 包 | 一句话 |
|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | Host 插件 + 浏览器半边（双面包）：Host 半边导入并挂载，浏览器半边提供设置页那一页 |

一个包、一条 Loader 行：`0.3.0` 起这两半合并了，此前是两个包、两行（见[从 0.2.x 升级](#从-02x-升级)）。

当前发布 **`0.3.1`**：技能改为逐行开关启停（关掉的名字显示为「已停用」而不是没导入过），配置页的来源改为一行一个开关、明细可折叠，打开后才显示该工具的目录项。明细见[更新日志](packages/agent-import/README.md#更新日志)。

## 能做什么

| 能力 | 说明 |
|---|---|
| **MCP 服务器** | `[mcp_servers.*]`（Codex `config.toml`）、`mcpServers`（Claude Code `~/.claude.json`、项目 `.mcp.json`）经 dsh 的 `mcp-client` 变成 `mcp__<server>__<tool>` 工具 |
| **技能** | 各 Agent 的技能目录（共 22 个来源：21 个工具 + 项目级根）按 frontmatter 的 `name` 归并，同名时按 rank 自动选一个，以**符号链接**导入 `~/.dsh/skills`；同一份文件（`realpath` 相同，例如经 CC Switch 中转的多个工具）只导入一次，dsh 自己放的真实技能永不被覆盖或删除；**移除会被记住**（记在 `~/.dsh/agent-import/state.json` 里，只存名字），重启后不会被自动补回，直到你再次导入它 |
| **不拖垮整场导入** | 读不懂的声明只记一条 `agent-import: …` 警告并跳过，其余照常导入 |
| **热生效** | 插件自己的配置是热生效的：设置页保存后立即重新导入，不需要重启 |
| **一页说清结果** | 设置页分「**已加载**」「**技能**」「**配置**」三个 tab：「已加载」用表格列出本次导入实际挂载的 MCP 服务器（状态、命令或 URL、跳过原因）与已导入的技能；「技能」可搜索、按状态与来源浏览、查看技能正文，每一行自带启停开关（被关掉过的技能显示为「已停用」而不是没导入过），同名冲突可就地改选来源；「配置」里每个来源占一行、右侧一个开关，打开后才显示该工具的目录项，可折叠展开 |
| **最小暴露** | 报告里只有名字与位置：服务器的参数、环境变量与请求头不进响应 |

## 安装

装一个包就够：Host 半边提供设置命名空间，同一个包的浏览器半边提供设置页那一页 —— 页面挂在声明了 `dsh.client` 的那条 Loader 行上，所以它天然跟着 Host 走。

> **环境要求**：`@deepseek-ai/cordis ^4.0.3`，以及 `@deepseek-ai/dsh-mcp-client` / `@deepseek-ai/dsh-skill` `>=0.1.7-alpha.2 <0.3.0-0`（peer 依赖，由 dsh 运行时提供；范围覆盖 0.1.7 起的 0.1.x 与 0.2.x，包括桌面端自带的运行时）。页面本身只要有设置外壳就出现；只有「已加载」一节读 `/agent-import/report`，所以它需要组合里的 `ctx.webServer`（dsh Web 与桌面端都有）。

> **为什么是设置页，不是插件页的「官方」分组。** 浏览器半边注册的是设置页的 `settings.section` 分栏，与 `general` / `models` / `account` / `plugins` 并列。插件页那个 `plugins.item` slot 按契约是官方设置卡的位置（官方占用者：`agent-loop` / `shell` / `subagent` / `web-search`）；第三方插件自己的配置页用 `settings.section`，或插件区内的 `settings.plugins.tab`。

### 1. 装包

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

<details>
<summary>从本仓库安装（改插件本身时才需要）</summary>

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<本仓库绝对路径>/packages/agent-import"
# 或者先 pnpm pack，再装生成的 .tgz
```

</details>

### 桌面端（Electron）

桌面端不是另一个客户端：它用同一套 `dsh-web-app` 组合，外加一个**自带版本**的 dsh 运行时，页面由 Host 自己的 `ctx.webServer` 在本机端口上提供 —— 所以两个半边都照常工作，只是 **Profile 是 `desktop`**，不是 `web`：

```sh
dsh plugin --profile desktop add @free-lzj/dsh-agent-import
```

> 桌面端自带的运行时版本与全局 CLI 通常**不是**同一个版本。若它落在本包 peer 范围之外，dsh 启动时的兼容性预检会把这一行**整行禁用**（stderr 打印 `dsh: disabling profile plugin row "agent-import": …`），插件与设置页都不会出现。两种解法：装一个 peer 范围覆盖该运行时的版本，或对精确版本授权 —— `dsh plugin --profile desktop allow-version <包@版本> --dsh-version <运行时版本> --accept-risk`（桌面端插件页对不兼容项也提供授权入口）。

### 2. 声明一行（必须）

装包只让它可解析；插件要真正启用，还得在 profile 里声明这一行。可以写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`web`、`desktop` 等），也可以用 overlay 启动：

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'
```

```sh
dsh web --patch examples/agent-import.cordis.yml
```

> **`agent-import` 这个 id 不能改。** dsh 用行自身的条目 id 命名它的设置命名空间，而设置页那一页跟随的正是这个命名空间；换个 id 就是另一个命名空间，页面不会出现。

### 3. 生效

Host 半边是启动时加载的 JS，**改了要重启 `dsh web`**；浏览器半边（`lib/client.js`）刷新页面即可。

### 从 0.2.x 升级

0.2.x 是两个包、两条 Loader 行（`@free-lzj/dsh-agent-import` + `@free-lzj/dsh-client-ui-settings-agent-import`）。0.3.0 把它们合成一个包，`@free-lzj/dsh-client-ui-settings-agent-import` 不再发布：

```sh
dsh plugin --profile web remove @free-lzj/dsh-client-ui-settings-agent-import
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

然后把 profile 里那两条 `insert` 行删掉 `ui-settings-agent-import` 那条，只留 `id: agent-import`（内容与上面示例一致），重启 `dsh web`。设置页来自包自身的 `dsh.client` 声明，不需要再单独声明。

## 配置

设置页覆盖全部字段；配置文件里等价于：

```yaml
- id: agent-import
  name: '@free-lzj/dsh-agent-import'
  config:
    sources: ['codex', 'claude-code']
    serverDenyList: ['node_repl']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `['codex', 'claude-code']` | 要读取 MCP 服务器的工具，按优先级排列 |
| `skillSources` | `['codex', 'claude-code']` | **自动导入**的来源（22 个可选值见[包 README](packages/agent-import/README.md#配置)）；技能目录始终全部读取并列出，没打开的来源可以逐个手动导入 |
| `skillAutoImport` | `true` | 激活时是否把来源技能自动建为链接 |
| `codex.home` | `$CODEX_HOME`，否则 `~/.codex` | 存放 Codex `config.toml` 与 `skills/` 的目录 |
| `codex.configPath` | `<home>/config.toml` | 要读的 Codex 配置文件 |
| `codex.includeSystemSkills` | `false` | 连 Codex 自带的 `skills/.system` 一起导入 |
| `claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude` | 存放 Claude Code 技能的目录 |
| `claudeCode.configPath` | `~/.claude.json` | 存放用户级服务器与工作区覆盖的 Claude Code 配置 |
| `projectRoot` | 空，取进程工作目录 | 读取项目级服务器与技能目录的工作区 |
| `mcp` | `true` | 是否挂载导入的 MCP 服务器 |
| `skills` | `true` | 是否导入并管理技能 |
| `serverDenyList` | `[]` | 不挂载的服务器名，按声明工具里的原名匹配 |
| `maxServers` | `64` | 最多挂载多少个导入的服务器 |
| `maxSkills` | `200` | 一次最多读取多少个技能 |
| `failOnStartupError` | `false` | 某个导入的服务器启动失败时是否拒绝激活本插件 |

## 「已加载」怎么来的

Host 插件在 `GET /agent-import/report` 上公布当前那次导入的结果，设置页的「已加载」一节用同源 `fetch` 读它。这条路由和 dsh 自己的页面同源，但不在 API 网关的会话校验之内，所以它只回答**同源**请求（`Sec-Fetch-Site` 既不是 `same-origin`/`none`、或 `Origin` 与 `Host` 不一致，直接 403；非 GET/HEAD 405），并且只带名字与位置：服务器的参数、环境变量与请求头不出现在响应里。

技能这一侧是**按请求现读磁盘**的：`skills` 说的是 dsh 自己技能目录里当前有什么（导入的链接与手工放的真实技能）——那才是 dsh 真正加载的东西；在外部增删技能后点一次「刷新」即可看到。服务器的挂载结果来自当前这次导入生成。

「技能」一节的读写走另外三条路由：`GET /agent-import/skills`（整份目录）、`GET /agent-import/skills/content?name=&source=`（一条技能的正文）、`POST /agent-import/skills/import` 与 `POST /agent-import/skills/remove`。写路由除了同源之外还要求 `x-dsh-agent-import: 1` 与 `content-type: application/json`：跨站表单发不出这个自定义头，所以你在浏览器里打开的任意页面都无法借你的手导入或移除技能。

## 开发

```sh
pnpm install
pnpm run typecheck   # 单包（两个半边一起）
pnpm run build       # tsc 出类型 + tsdown 出 lib/index.js（Node 半边）、lib/client.js（浏览器半边）
pnpm run test        # vitest：16 个 spec 文件 / 250 个测试
```

先 `build` 再 `test`：[`tests/package-faces.client.spec.ts`](packages/agent-import/tests/package-faces.client.spec.ts) 校验的是**产物**（注册 id、`dsh.client` 声明、`exports["./client"]`、浏览器入口有没有向 Host 半边取值），没有 `lib/` 时其中一条会显示为 skipped。

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 `windows-latest` 上跑：adapter 的 spec 断言 Windows 盘符路径（Codex / Claude Code 主目录用 `C:`、`D:` 夹具），在 Linux 上这些夹具会被当成相对路径。

浏览器半边的 spec 需要 dsh 客户端包的 Node 半边与模块表，[`vitest.config.ts`](vitest.config.ts) 与 [`packages/agent-import/tests/support/`](packages/agent-import/tests/support) 说明了这两处接线（见包 README 的「测试如何拿到 dsh 的客户端代码」）。

### 发布

```sh
cd packages/agent-import
npm publish      # prepublishOnly 会先 build；--access public 写在 publishConfig 里
```

- 版本号在 [`packages/agent-import/package.json`](packages/agent-import/package.json)；npm 上已占用的版本不能重发。
- 账号开了 auth-and-writes 2FA 时，`npm publish` 需要 OTP，或者用**勾了 Bypass 2FA 的 granular access token**：普通 token 会以 `403 … bypass 2fa enabled is required` 失败。
- npm 包页的 README 取自 tarball，发布之后再改 README 不会同步到 npm，要发一个新版本。

## 已知限制

- 这个包**不在 dsh 自带 Web 组合里**，必须在 profile 中自行声明上面那一行。
- 「已加载」走的是 dsh Web 自身的 HTTP 路由，所以这一节需要有 `ctx.webServer` 的组合。dsh Web 与 Electron 桌面端都有（桌面端的页面就是 Host 的 `ctx.webServer` 在本机端口上提供的）；在没有 `ctx.webServer` 的组合里，这一节显示为不可用，其余配置照常。
- dsh 启动时会做兼容性预检：peer 范围不含当前运行时的插件会被整行禁用（stderr 里打印 `dsh: disabling profile plugin row …`），**此时设置页完全不出现**，看起来像没装上。用 `dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 对精确版本授权即可放行。本包的 peer 范围覆盖 0.1.x 与 0.2.x 运行时，再往后的运行时需要放宽范围或授权。
- 「已加载」一节只回答「挂载了吗」：服务器挂载成功但自身连不上时，连接错误由 dsh 的 `mcp-client` 自己记日志（`failOnStartupError: false` 时它会持续重连），这一行仍显示「已挂载」。
- 外部配置文件只在激活时读取一次（本插件自身配置除外）：Codex / Claude Code 那边改了声明，需要重载或重启 dsh。
- **Windows 上的文件型技能**（`<root>/<name>.md` 而不是一个目录）建符号链接需要开发者模式；本插件不会退化成复制或硬链接（硬链接无法被识别为链接），而是跳过并报 `unsupported`。目录型技能在 Windows 上用 junction，任何权限下都能导入。
- 与 `@michengai/dsh-skills-manager` 并存时两者互不感知：那个插件会跳过 `~/.dsh/skills` 下的符号链接，因此看不到也不管理本插件导入的技能；同一批技能建议只用其一管理。
- 两边工具的插件市场（如 Codex `plugin.json`）不会展开，只导入服务器声明和技能目录。
- 真实组合的端到端测试（真装 dsh 启动一次、断言工具与技能可见）留在 dsh 主仓库里跑 —— 它依赖主仓库自带的 profile 启动夹具；本仓库的 CI 跑类型检查、构建与单元/组件测试。

## License

[MIT](LICENSE)
