<div align="center">

# @free-lzj/dsh-agent-import

**读取 Codex / Claude Code 已经声明的 MCP 服务器与技能，挂载进 DeepSeek Harness；同一个包还在 dsh 设置页里带一页「代理配置导入」。**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/Free-LZJ/free-dsh-plugins/blob/main/LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4f46e5.svg)](https://github.com/Free-LZJ/free-dsh-plugins#readme)

[仓库 README](https://github.com/Free-LZJ/free-dsh-plugins#readme) · [示例 overlay](https://github.com/Free-LZJ/free-dsh-plugins/blob/main/examples/agent-import.cordis.yml) · [设置页](#设置页)

</div>

---

这是一个**双面包**：两半出自同一次构建，由包自己的 `dsh.client` 声明挂在**同一条 Loader 行**上，所以只装一个包、只声明一行。

| 半边 | 产物 | 入口 | 跑在哪 |
|---|---|---|---|
| **Host** | `lib/index.js`（ESM） | `src/index.ts` | Node 进程：Loader 行挂载的插件本体，提供设置命名空间与 `GET /agent-import/report` |
| **浏览器** | `lib/client.js`（module-table 闭包工厂） | `src/client/index.ts` | 页面：设置页那一页，按行 id 索引命名空间后注册 |

## 安装与声明

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

装包只让它可解析，插件要启用还得在 profile 里声明这一行 —— **`id` 不能改名**：设置命名空间与设置页都按这个 id 索引。

> Profile 要选你实际在跑的那个：`dsh web` 用 `web`，**Electron 桌面端用 `desktop`**（桌面端是同一个 `dsh-web-app` 组合加一份自带版本的 dsh 运行时，Profile 不通用）。
>
> peer 依赖 `@deepseek-ai/dsh-mcp-client` / `@deepseek-ai/dsh-skill` 由 dsh 运行时提供，范围是 `>=0.1.7-alpha.2 <0.3.0-0`。运行时版本落在范围外时，dsh 启动的兼容性预检会**整行禁用**这条 Loader 行（stderr 打印 `dsh: disabling profile plugin row "agent-import": …`），插件与设置页都不会出现；用 `dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 对精确版本授权即可放行。

```yaml
- id: agent-import
  name: '@free-lzj/dsh-agent-import'
  config:
    sources: ['codex', 'claude-code']
    serverDenyList: ['node_repl']
```

从本仓库安装、用 overlay 启动、以及 0.2.x 的升级步骤，见[仓库根 README](https://github.com/Free-LZJ/free-dsh-plugins#readme)。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `['codex', 'claude-code']` | 要读取的工具，按优先级排列；重复的源只读一次 |
| `codex.home` | `$CODEX_HOME`，否则 `~/.codex` | 存放 Codex `config.toml` 与 `skills/` 的目录 |
| `codex.configPath` | `<home>/config.toml` | 要读的 Codex 配置文件 |
| `codex.includeSystemSkills` | `false` | 连 Codex 自带的 `<home>/skills/.system` 一起发布 |
| `claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude` | 存放 Claude Code `skills/` 的目录 |
| `claudeCode.configPath` | `~/.claude.json` | 存放用户级服务器与工作区覆盖的 Claude Code 配置 |
| `projectRoot` | 空，取进程工作目录 | 读取项目级服务器与 Claude 技能目录的工作区 |
| `mcp` | `true` | 是否挂载导入的 MCP 服务器 |
| `skills` | `true` | 是否发布导入的技能 |
| `serverDenyList` | `[]` | 不挂载的服务器名，按声明工具里的原名匹配 |
| `maxServers` | `64` | 最多挂载多少个导入的服务器 |
| `maxSkills` | `200` | 最多发布多少个导入的技能 |
| `failOnStartupError` | `false` | 某个导入的服务器启动失败时是否拒绝激活本插件 |

全部字段都是 `Volatile`：从设置页或任何 profile 写入都会就地重新导入，不重启进程。

## 行为

- **Codex**：读 `<home>/config.toml` 的 `[mcp_servers.<name>]` 及其 `env` / `http_headers` 子表，以及 `<home>/skills` 下的技能目录。`type` 为 `stdio` 或缺省表示本地程序，`http` / `streamable-http` 表示远端；`env_vars` 从 `process.env` 取值的变量并到 `env` 之下，`bearer_token_env_var` 变成 `Authorization: Bearer` 头。
- **Claude Code**：读 `~/.claude.json` 的用户级 `mcpServers`、同一文件里 `projects.<path>.mcpServers` 的工作区覆盖，以及项目级 `<project>/.mcp.json`；技能目录来自 `<configDir>/skills` 与 `<project>/.claude/skills`。工作区键做路径归一化后匹配。
- **服务器命名**：外部名字归一化到 dsh 的 `[A-Za-z0-9_-]{1,32}` 命名空间；冲突时按声明顺序变成 `name`、`name-2`，超过 32 字符保留原名加六位十六进制摘要。
- **技能优先级**：导入技能注册在 rank 550——低于 dsh 的项目级与用户级技能根，高于随附技能——因此同名的 dsh 技能总是胜出；两个导入源之间按 `sources` 顺序先者胜。
- **失败处理**：读不懂的声明变成一条 `agent-import: …` 警告并跳过，激活照常成功；只有导入的服务器启动失败且 `failOnStartupError: true` 时才会拒绝激活。
- **重导入窗口**：重新导入时先卸载上一代再挂载下一代，因此中间有一瞬间两代都不在；那一瞬发出的请求看不到导入的工具与技能。
- **导入报告**：`GET /agent-import/report` 返回当前这一代的结果——`importedAt`、`sources`、`skills`（名字、描述、来源、`SKILL.md` 路径）、`servers`（名字、dsh 命名空间、传输方式、命令或 URL、来源、`mounted`/`skipped` 与原因）、`notes`。技能是按请求现读技能目录，所以外部增删技能后刷新即可看到；服务器行描述的是当前这一代。这条路由要求伪装成 dsh 自己页面的同源请求（见根 README「已加载」怎么来的），且不含参数、环境变量与请求头。

## 设置页

浏览器半边注册的是设置页的 `settings.section` 分栏，与 `general` / `models` / `account` / `plugins` 并列；插件页那个 `plugins.item` slot 按契约是官方设置卡的位置（官方占用者：`agent-loop` / `shell` / `subagent` / `web-search`），所以第三方插件自己的配置页走这里（插件区内则可用 `settings.plugins.tab`）。

页面的注册条件是 **Host 正在服务 `agent-import` 设置命名空间**：

- 命名空间就是 Loader 行的条目 id，所以那行必须叫 `agent-import`；换个 id 就是另一个命名空间，这一页永远不会出现。
- 页面来自包自身的 `dsh.client` 声明：行被停用或没装这个包时，页面直接消失（不是显示「未加载」），不留任何痕迹。
- 保存写入 Host 的设置表单；本部署不支持持久化时页面显示只读提示。

页面是一个 `SegmentedControl` 标签页，两个 tab：

- **已加载**（只读，默认打开）：当前这次导入的结果——技能与 MCP 服务器的条数摘要、**两张表格**（技能：名称 / 来源 / 指令文件；MCP 服务器：名称 / 状态 / 命令或 URL / 说明，说明列只在有行需要时出现）、导入提示，以及一个 **刷新** 按钮。路径与命令用等宽字体并截断显示，悬停可见全路径。数据来自 Host 的 `GET /agent-import/report`（同源 `fetch`），Host 没回答时显示原因而不是空白。
- **配置**：字段按四节分组——
  - **来源**：Codex / Claude Code 两个开关（`sources`）；
  - **路径**：`projectRoot`、Codex 主目录与配置文件、Claude Code 目录与配置文件，留空即沿用文档中的回退（`$CODEX_HOME`、`~/.claude` 等）；
  - **导入范围**：导入 MCP 服务器、导入技能、包含 Codex 自带技能、服务器启动失败即报错四个开关，以及 `maxServers`、`maxSkills` 两个数值（只接受 0 或更大的整数，留空表示使用默认值）；
  - **跳过的服务器**：`serverDenyList` 一行一个，可增删。

切换 tab 不会丢草稿（草稿在控制器里，不在组件里）；用户层显式设过的字段标 **已覆盖** 并提供 **恢复默认**；只有 **保存** 会写入，且一次性写全部暂存修改，离开页面丢弃草稿。

样式由 `src/client/agent-import-card-style.ts` 在 `apply` 时作为 `<style>` 注入：动态加载的浏览器半边拿不到外壳的样式表，而这一页只用 `--dsw-*` 设计令牌（另加一个 760px 宽度上限，与官方分栏一致——设置页的内容列本身不限宽），所以跟随主题。

## 构建

`tsc` 先把 `src/**` 编到 `lib/types/`，`tsdown` 再打两个面：

- **Host 半边** `lib/index.js`（ESM）：入口 `lib/types/index.js`，包声明的依赖与 peer（`schemastery`、`yaml`、`cordis`、`dsh-mcp-client`、`dsh-skill`）保持外置。
- **浏览器半边** `lib/client.js`（浏览器 CJS，包在 module-table 的闭包工厂里）：入口 `lib/types/client/index.js`，只打包 `src/client/**`；dsh Web 外壳共享的模块（React、`@deepseek-ai/cordis`、`client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`）保持外置，其余内联。

**`src/client/**` 不得对 Host 半边做值引用**，只能 `import type`（会被擦除）：否则 tsdown 的相对路径内联会把 `yaml`、`mcp-client` 那坨 Node 代码打进浏览器包。导入报告的结构就是这条规则的一个例子——它只在 `src/report.ts` 定义一次，浏览器半边以类型引用。

`tests/package-faces.client.spec.ts` 把这些约定钉在**产物**上：它在 jsdom 里按外壳的模块表协议求值 `lib/client.js`，断言注册 id 就是包名、导出形状正确、且这个 bundle 没有向外壳索取任何它不 seed 的模块（也就是上面那条纯度规则）。它读 `lib/`，所以要先 `pnpm run build`。

```sh
pnpm run typecheck
pnpm run build
pnpm run test      # 在本仓库根目录运行 vitest
```

### 测试如何拿到 dsh 的客户端代码

8 个浏览器半边 spec（`tests/*.client.spec.{ts,tsx}`，其中 5 个带 `@vitest-environment jsdom`）只依赖 npm 上发布的包，但有两处需要说明：

- **平台包只有 Node 半边。** `dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-slots` 在 npm 上不发布浏览器包（浏览器版本由 Web 外壳自己打进 bundle），其 Node 半边的依赖保持外置。所以本包把这些外部依赖（`clsx`、`zustand`、`immer`、`shiki`、`katex`、`micromark` 系列等）显式声明为 `devDependencies`，并让 `vitest.config.ts` 的 `server.deps.inline` 把它们交给 Vite 转换——CSS 模块也走这条路径。
- **浏览器半边按模块表加载。** `dsh-client-locale`、`dsh-client-ui-renderer`、`dsh-client-ui-settings` 发布的 `lib/client.js` 是给 Web 外壳的模块表用的：它调用 `window.__ModuleLoader__.load({ id, factory })`，通过外壳给的 `require` 取平台模块。`tests/support/module-loader.ts`（经 `setupFiles` 装载）在 jsdom 里装一张最小模块表，spec 再用 `clientModule(id)` 取它的导出。
- `tests/support/runtime.ts` 是 dsh 仓库里 `@deepseek-ai/dsh-client-test-runtime` 的本地替身：那个包发布时保留了只在 dsh 仓库内存在的源码路径，无法从 npm 使用。

## 已知限制

- 不在 dsh 自带 Web 组合里，必须自行安装并声明那一行。
- 设置页只在 Host 服务该命名空间期间存在；行停用即撤销 —— 其中包括被 dsh 兼容性预检禁用的情形，此时设置页**完全不出现**，看起来像没装上。
- 报告路由与 **已加载** 一节只在有 `ctx.webServer` 的组合里存在：dsh Web 与 Electron 桌面端都有（桌面端的页面就是 Host 的 `ctx.webServer` 在本机端口上提供的），没有它的组合里这一节显示为不可用。
- 服务器行只说「挂载了吗」：挂载成功但自身连不上时，错误由 dsh 的 `mcp-client` 记日志（`failOnStartupError: false` 时它会重连），该行仍为 `mounted`。
- 外部文件只在激活时读取（本插件自身配置除外）：Codex / Claude Code 侧改了声明需要重载或重启。
- 不展开两边工具自己的插件市场（如 Codex `plugin.json`）。
- Codex 的 `startup_timeout_sec` 在 dsh 侧没有对应项；Claude Code 的 `sse` 传输不支持。

## 源码结构

`src/index.ts` 是插件本体（字段声明、导入代际、热重导、报告路由注册），`src/report.ts` 是报告类型与那条同源路由，`src/adapters/{codex,claude-code}.ts` 各自解析一种外部格式，`src/mcp.ts` 负责把服务器挂到 `mcp-client`，`src/skills.ts` 是技能 provider，`src/toml.ts` / `src/skill-file.ts` / `src/values.ts` 是纯解析与取值工具，`src/client/**` 是设置页那一页。
