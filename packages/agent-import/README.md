<div align="center">

# @free-lzj/dsh-agent-import

**把 Codex / Claude Code 已经声明的 MCP 服务器挂载进 DeepSeek Harness，并把各 Agent 工具的技能以符号链接导入 dsh 自己的技能目录来管理；同一个包还在 dsh 设置页里带一页「代理配置导入」。**

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
| `sources` | `['codex', 'claude-code']` | 要读取 MCP 服务器的工具，按优先级排列；重复的源只读一次 |
| `skillSources` | `['codex', 'claude-code']` | **自动导入**的来源，取值见下表。技能目录始终全部读取并列出（只读，不写任何外来目录），因此没勾选的来源照样能在设置页里看到、并逐个手动导入 |
| `skillAutoImport` | `true` | 激活时（以及启用来源集合变化时）是否把**已勾选来源**的技能自动建为链接 |
| `codex.home` | `$CODEX_HOME`，否则 `~/.codex` | 存放 Codex `config.toml` 与 `skills/` 的目录（同时决定技能目录） |
| `codex.configPath` | `<home>/config.toml` | 要读的 Codex 配置文件 |
| `codex.includeSystemSkills` | `false` | 连 Codex 自带的 `<home>/skills/.system` 一起导入 |
| `claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude` | 存放 Claude Code `skills/` 的目录 |
| `claudeCode.configPath` | `~/.claude.json` | 存放用户级服务器与工作区覆盖的 Claude Code 配置 |
| `projectRoot` | 空，取进程工作目录 | 读取项目级服务器与技能目录的工作区 |
| `mcp` | `true` | 是否挂载导入的 MCP 服务器 |
| `skills` | `true` | 是否导入并管理技能；关掉后技能路由答空目录、自动导入不运行 |
| `serverDenyList` | `[]` | 不挂载的服务器名，按声明工具里的原名匹配 |
| `maxServers` | `64` | 最多挂载多少个导入的服务器 |
| `maxSkills` | `200` | 一次最多读取多少个技能 |
| `failOnStartupError` | `false` | 某个导入的服务器启动失败时是否拒绝激活本插件 |

全部字段都是 `Volatile`：从设置页或任何 profile 写入都会就地重新导入，不重启进程。

`skillSources` 的取值（下表也是**会被读取的全部来源**；带项目级的工具同样读项目目录）：

| id | 工具 | 用户级目录 |
|---|---|---|
| `dsh` | dsh 自己 —— **总是读取**，也是唯一的写入目标 | `$DSH_HOME`，否则 `~/.dsh`，加 `/skills` |
| `agents` | 通用 Agent 目录 | `$DSH_AGENTS_HOME`，否则 `~/.agents`，加 `/skills` |
| `project` | 当前工作区 | `<project>/skills` |
| `cc-switch` | CC Switch | `~/.cc-switch/skills` |
| `codex` | Codex | `$CODEX_HOME`，否则 `~/.codex`，加 `/skills` |
| `claude-code` | Claude Code | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude`，加 `/skills` |
| `gemini` `opencode` `cursor` `copilot` `windsurf` `trae` `roo` `codebuddy` `workbuddy` `qoder` `lingma` 等 | 同名工具（另有 `windsurf-legacy`、`trae-cn`、`qoder-cn`、`openclaw`、`clawdbot`） | `~/.<工具>/skills`、`~/.config/opencode/skills` 一类 |

精确目录、环境变量与 rank 见 `src/skill-roots.ts` 的 `SKILL_SOURCES`。

## 行为

- **Codex**：读 `<home>/config.toml` 的 `[mcp_servers.<name>]` 及其 `env` / `http_headers` 子表，以及 `<home>/skills` 下的技能目录。`type` 为 `stdio` 或缺省表示本地程序，`http` / `streamable-http` 表示远端；`env_vars` 从 `process.env` 取值的变量并到 `env` 之下，`bearer_token_env_var` 变成 `Authorization: Bearer` 头。
- **Claude Code**：读 `~/.claude.json` 的用户级 `mcpServers`、同一文件里 `projects.<path>.mcpServers` 的工作区覆盖，以及项目级 `<project>/.mcp.json`；技能目录来自 `<configDir>/skills` 与 `<project>/.claude/skills`。工作区键做路径归一化后匹配。
- **服务器命名**：外部名字归一化到 dsh 的 `[A-Za-z0-9_-]{1,32}` 命名空间；冲突时按声明顺序变成 `name`、`name-2`，超过 32 字符保留原名加六位十六进制摘要。
- **技能导入**：每个已知来源的技能目录都被扫成一张表（`<root>/<name>/SKILL.md`，或 `<root>/<name>.md`），按 frontmatter 的 `name` 归并——dsh 也是按 `name` 而不是目录名寻址技能。`realpath` 相同（同一份文件，例如经 CC Switch 中转的多个工具）只算一条候选，因此不会为同一份技能重复建链。
- **读取范围 ≠ 自动导入范围**：目录**始终**扫描全部 22 个已知来源（含项目级根），设置页因此能列出你所有工具里的技能（Gemini、Cursor、Trae、`~/.agents` 等，无需任何配置），并可逐个手动导入；而**无人要求就不会写入**：自动导入只取 `skillSources` 里勾选的来源，默认只有 Codex 与 Claude Code。扫描是只读的，也不进入 dsh 的 prompt——dsh 只加载它自己技能目录里的东西。
- **同名裁决**：一条技能有多个来源时按 rank 自动选一个：项目级 dsh（100–199）< 用户级 dsh 400 < `~/.agents/skills` 450 < 项目级外来根（470+）< 各用户级外来根（500+）。选中项被**符号链接**到 `~/.dsh/skills/<name>`（Windows 用 junction，不需要管理员权限，也不需要开发者模式），dsh 的 filesystem 技能 provider 会穿透链接把它当本地技能加载；源目录一个字节都不改写。冲突会在设置页显式提示，并可改选另一个来源（改选即重建链接）。
- **只写用户级**：自动导入只在 `~/.dsh/skills` 下建链接，绝不写项目仓库；项目级技能根只读，用于展示与裁决。
- **不动本地技能**：`~/.dsh/skills` 里手工放的**真实目录或文件**永不被覆盖、替换或删除，设置页把它们标为「本地」；「移除」只对链接生效。
- **移除是一个决定，会被记住**：如果移除只删链接，激活时的自动导入下一次就会把它补回来——看起来像没生效。插件因此把自己的决定写在 `$DSH_HOME/agent-import/state.json`（默认 `~/.dsh/agent-import/state.json`）：里面只有被移除的技能名，不含技能内容；自动导入不再碰这些名字，在设置页重新导入即清除该记录。删掉这个文件等同于撤销所有移除决定，下次激活会重新补链。
- **失败处理**：读不懂的声明变成一条 `agent-import: …` 警告并跳过，激活照常成功；只有导入的服务器启动失败且 `failOnStartupError: true` 时才会拒绝激活。
- **重导入窗口**：重新导入时先卸载上一代再挂载下一代，因此中间有一瞬间两代都不在；那一瞬发出的报告与技能目录请求会答成空的。
- **导入报告**：`GET /agent-import/report` 返回当前这一代的结果——`importedAt`、`sources`、`skills`（名字、描述、来源、`SKILL.md` 路径）、`servers`（名字、dsh 命名空间、传输方式、命令或 URL、来源、`mounted`/`skipped` 与原因）、`notes`。`skills` 说的是 **dsh 自己技能目录里现在有什么**（导入的链接与手工放的真实技能），因为那才是 dsh 真正加载的东西。这条路由要求伪装成 dsh 自己页面的同源请求，且不含参数、环境变量与请求头。
- **技能路由**：`GET /agent-import/skills` 答整份目录（每条技能的名字、描述、状态 `available`/`linked`/`local`/`broken`、冲突标记、各来源候选及其 `SKILL.md` 路径）；`GET /agent-import/skills/content?name=&source=` 答一条技能的正文给详情视图（不带 `source` 时读已导入的那份，超过 256 KiB 拒绝显示）；`POST /agent-import/skills/import`（`{name, source?, replace?}`）与 `POST /agent-import/skills/remove`（`{name}`）执行单项导入与移除。两个写路由除同源外还要求 `x-dsh-agent-import: 1` 与 `content-type: application/json`——跨站表单发不出这个自定义头，这是浏览器侧可靠的写保护；body 上限 64 KiB。

## 设置页

浏览器半边注册的是设置页的 `settings.section` 分栏，与 `general` / `models` / `account` / `plugins` 并列；插件页那个 `plugins.item` slot 按契约是官方设置卡的位置（官方占用者：`agent-loop` / `shell` / `subagent` / `web-search`），所以第三方插件自己的配置页走这里（插件区内则可用 `settings.plugins.tab`）。

页面的注册条件是 **Host 正在服务 `agent-import` 设置命名空间**：

- 命名空间就是 Loader 行的条目 id，所以那行必须叫 `agent-import`；换个 id 就是另一个命名空间，这一页永远不会出现。
- 页面来自包自身的 `dsh.client` 声明：行被停用或没装这个包时，页面直接消失（不是显示「未加载」），不留任何痕迹。
- 保存写入 Host 的设置表单；本部署不支持持久化时页面显示只读提示。

页面是一个 `SegmentedControl` 标签页，三个 tab：

- **已加载**（只读，默认打开）：当前这次导入的结果——技能与 MCP 服务器的条数摘要、**两张表格**（技能：名称 / 来源 / 指令文件；MCP 服务器：名称 / 状态 / 命令或 URL / 说明，说明列只在有行需要时出现）、导入提示，以及一个 **刷新** 按钮。路径与命令用等宽字体并截断显示，悬停可见全路径。数据来自 Host 的 `GET /agent-import/report`（同源 `fetch`），Host 没回答时显示原因而不是空白。
- **技能**：技能管理器本身——搜索（名字、描述、来源）、按状态与来源浏览、每条显示名字 / 描述 / 来源 / 状态（**可导入** / **已导入** / **本地** / **链接失效**），同名多源时显式提示还有哪些来源并可就地改选（改选即重建链接），每条可 **导入**、**移除**、**查看正文**（正文在面板里只读展示，附解析出的指令文件路径）。真实本地技能不提供「移除」，只说明它归本地所有。数据来自 `GET /agent-import/skills`，写入走 `POST /agent-import/skills/import` 与 `/skills/remove`，写完重新拉一次目录并把跳过的原因显示出来；`skills` 开关关闭时这一栏显示说明而不是空列表。**没勾进「技能来源」的工具的技能同样会列出**（扫描始终覆盖全部来源），可以直接在这一栏里逐个导入。
- **配置**：字段按四节分组——
  - **来源**：两组多选——**MCP 来源**（Codex / Claude Code，即 `sources`）与**技能来源**（`skillSources`，22 个已知来源的勾选列表）；后者决定**自动导入**谁，未勾选的来源仍然会出现在「技能」栏里、可逐个手动导入；
  - **路径**：`projectRoot`、Codex 主目录与配置文件、Claude Code 目录与配置文件，留空即沿用文档中的回退（`$CODEX_HOME`、`~/.claude` 等）；
  - **导入范围**：导入 MCP 服务器、导入技能、**自动导入技能**（`skillAutoImport`）、包含 Codex 自带技能、服务器启动失败即报错五个开关，以及 `maxServers`、`maxSkills` 两个数值（只接受 0 或更大的整数，留空表示使用默认值）；
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
- 外部 **MCP 声明**只在激活时读取（本插件自身配置除外）：Codex / Claude Code 侧改了服务器声明需要重载或重启。**技能目录是按请求现读的**，在外部增删技能后刷新设置页即可看到。
- 不展开两边工具自己的插件市场（如 Codex `plugin.json`）。
- Codex 的 `startup_timeout_sec` 在 dsh 侧没有对应项；Claude Code 的 `sse` 传输不支持。
- **Windows 上的文件型技能**：技能若是一个 `.md` 文件而不是目录（`<root>/<name>.md`），建符号链接需要 Windows 开发者模式。本插件**不会**退化成复制或硬链接（硬链接无法被识别为链接，会让「移除」失效并让技能看起来是本地文件），而是跳过并报 `unsupported`，设置页说明原因。目录型技能在 Windows 上用 junction，任何权限下都能导入。
- **与 `@michengai/dsh-skills-manager` 并存**：那个插件会跳过 `~/.dsh/skills` 下的符号链接，启用/停用状态存在它自己的 `~/.dsh/skills-manager/state.json` 里，因此它既看不到也不管理本插件导入的技能；两者互不感知，同一批技能建议只用其一管理。

## 源码结构

`src/index.ts` 是插件本体（字段声明、导入代际、热重导、路由注册），`src/report.ts` 是报告类型与那条同源路由，`src/adapters/{codex,claude-code}.ts` 各自解析一种外部格式，`src/mcp.ts` 负责把服务器挂到 `mcp-client`。技能一侧：`src/skill-roots.ts` 是各 Agent 的技能根目录表，`src/skill-links.ts` 建/读/删链接，`src/skill-scan.ts` 扫描，`src/skill-catalog.ts` 归并与同名裁决，`src/skill-import.ts` 导入与移除，`src/skill-state.ts` 记住用户移除过哪些名字，`src/http.ts` + `src/skill-routes.ts` 是那四条路由与请求校验。`src/toml.ts` / `src/skill-file.ts` / `src/values.ts` 是纯解析与取值工具，`src/client/**` 是设置页那一页。
