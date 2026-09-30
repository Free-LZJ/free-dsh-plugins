# free-dsh-plugins

我自己的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件集。

| 包 | 角色 |
|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | **Host 插件**：读取 Codex / Claude Code 已经声明的 MCP 服务器与技能，挂载到 dsh 自己的 MCP 客户端与技能目录里 |
| [`@free-lzj/dsh-client-ui-settings-agent-import`](packages/ui-settings-agent-import/README.md) | **浏览器伴生包**：在 dsh Web 的插件页「官方」分组注册一张「代理配置导入」卡片，实时读写上面那个插件的配置 |

English: [README.en.md](README.en.md)

## 这个插件做什么

同一台机器上如果已经在用 Codex 或 Claude Code，它们的 MCP 服务器和技能不用再往 dsh 里抄一遍：

- `[mcp_servers.*]`（Codex `config.toml`）、`mcpServers`（Claude Code `~/.claude.json`、项目 `.mcp.json`）→ 通过 dsh 的 `mcp-client` 变成 `mcp__<server>__<tool>` 工具；
- 两边的 `skills/` 目录 → 作为一个技能 provider 进入 dsh 技能目录（同名时 dsh 自己的技能优先）；
- 读不懂的声明只记一条 `agent-import: …` 警告并跳过，不会拖垮其余导入；
- 插件自己的配置是**热生效**的：插件页保存后立即重新导入，不需要重启；
- 插件页那张卡片最上方是「**已加载**」：当前这次导入实际挂载的 MCP 服务器（传输方式、命令或 URL、已挂载/已跳过及原因）和已发布的技能（名字、来源、`SKILL.md` 路径），带一个「刷新」按钮。

## 安装

两个包都要装：Host 插件提供设置命名空间，伴生包提供那张卡片。

### 从 npm 安装（发布后）

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import @free-lzj/dsh-client-ui-settings-agent-import
```

### 从本仓库安装（未发布时）

```sh
pnpm install
pnpm run build

# 用目录或 tarball 装进你的 profile
dsh plugin --profile web add "<本仓库绝对路径>/packages/agent-import" "<本仓库绝对路径>/packages/ui-settings-agent-import"
# 或者先 pnpm pack，再装生成的 .tgz
```

### 声明两行（必须）

装包只让它们可解析；插件要真正启用，还得在你的 profile 里声明两行。可以写进 `$DSH_HOME/profiles/web/cordis.patch.yml`，也可以用 overlay 启动：

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'

    - id: ui-settings-agent-import
      name: '@free-lzj/dsh-client-ui-settings-agent-import'
```

```sh
dsh web --patch examples/agent-import.cordis.yml
```

**`agent-import` 这个 id 不能改**：dsh 用行自身的条目 id 命名它的设置命名空间，插件页那张卡片跟随的正是这个命名空间。

## 配置字段

插件页卡片覆盖全部字段；配置文件里等价于：

```yaml
- id: agent-import
  name: '@free-lzj/dsh-agent-import'
  config:
    sources: ['codex', 'claude-code']
    serverDenyList: ['node_repl']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `['codex', 'claude-code']` | 要读取的工具，按优先级排列 |
| `codex.home` | `$CODEX_HOME`，否则 `~/.codex` | 存放 Codex `config.toml` 与 `skills/` 的目录 |
| `codex.configPath` | `<home>/config.toml` | 要读的 Codex 配置文件 |
| `codex.includeSystemSkills` | `false` | 连 Codex 自带的 `skills/.system` 一起发布 |
| `claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`，否则 `~/.claude` | 存放 Claude Code 技能的目录 |
| `claudeCode.configPath` | `~/.claude.json` | 存放用户级服务器与工作区覆盖的 Claude Code 配置 |
| `projectRoot` | 空，取进程工作目录 | 读取项目级服务器与 Claude 技能目录的工作区 |
| `mcp` | `true` | 是否挂载导入的 MCP 服务器 |
| `skills` | `true` | 是否发布导入的技能 |
| `serverDenyList` | `[]` | 不挂载的服务器名，按声明工具里的原名匹配 |
| `maxServers` | `64` | 最多挂载多少个导入的服务器 |
| `maxSkills` | `200` | 最多发布多少个导入的技能 |
| `failOnStartupError` | `false` | 某个导入的服务器启动失败时是否拒绝激活本插件 |

## 「已加载」怎么来的

Host 插件在 `GET /agent-import/report` 上公布当前那次导入的结果，卡片用同源 `fetch` 读它。这条路由和 dsh 自己的页面同源，但不在 API 网关的会话校验之内，所以它只回答**同源**请求（`Sec-Fetch-Site` 既不是 `same-origin`/`none`、或 `Origin` 与 `Host` 不一致，直接 403；非 GET/HEAD 405），并且只带名字与位置：服务器的参数、环境变量与请求头不出现在响应里。

技能列表是**按请求实时枚举**的（不是激活那一刻的快照），所以你在 Codex / Claude Code 那边增删技能后，点一次「刷新」就能看到；服务器的挂载结果来自当前这次导入生成。

同步规则：Host 半边是启动时加载的 JS，**改了要重启 `dsh web`**；浏览器半边（`lib/client.js`）刷新页面即可。

## 开发

```sh
pnpm install
pnpm run typecheck   # 两个包
pnpm run build       # tsc 出类型 + tsdown 出 lib/index.js、lib/client.js
pnpm run test        # vitest：15 个 spec 文件 / 246 个测试
```

CI（`.github/workflows/ci.yml`）在 `windows-latest` 上跑：adapter 的 spec 断言 Windows 盘符路径（Codex / Claude Code 主目录用 `C:`、`D:` 夹具），在 Linux 上这些夹具会被当成相对路径。

浏览器半边的 spec 需要 dsh 客户端包的 Node 半边与模块表，`vitest.config.ts` 与 `packages/ui-settings-agent-import/tests/support/` 说明了这两处接线（见该包 README 的「测试如何拿到 dsh 的客户端代码」）。

## 已知限制

- 这两个包**不在 dsh 自带 Web 组合里**，必须在 profile 中自行声明上面那两行。
- 「已加载」走的是 dsh Web 自身的 HTTP 路由：Electron 桌面端加载 `file://` 页面、没有 `ctx.webServer`，这张卡片在那里不显示这一节（其余配置照常可用）。要两端一致，需要在 dsh 自身的 `packages/api/remotes` 加一个 Remote 命名空间。
- 卡片只回答「挂载了吗」：服务器挂载成功但自身连不上时，连接错误由 dsh 的 `mcp-client` 自己记日志（`failOnStartupError: false` 时它会持续重连），卡片这一行仍显示「已挂载」。
- 外部配置文件只在激活时读取一次（本插件自身配置除外）：Codex/Claude Code 那边改了声明，需要重载或重启 dsh。
- 两边工具的插件市场（如 Codex `plugin.json`）不会展开，只导入服务器声明和技能目录。
- 真实组合的端到端测试（真装 dsh 启动一次、断言工具与技能可见）留在 dsh 主仓库里跑——它依赖主仓库自带的 profile 启动夹具；本仓库的 CI 跑类型检查、构建与单元/组件测试。

## License

[MIT](LICENSE)
