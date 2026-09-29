# @free-lzj/dsh-agent-import

读取 Codex / Claude Code 已经声明的 MCP 服务器与技能，通过 DeepSeek Harness 自己的 `mcp-client` 与技能目录挂载进来。

这是 **Host 半边**。插件页那张配置卡片在伴生包 [`@free-lzj/dsh-client-ui-settings-agent-import`](../ui-settings-agent-import/README.md) 里，两个包都要装、都要声明。

## 声明

```yaml
- id: agent-import          # 不能改名：设置命名空间与插件页卡片都按这个 id 索引
  name: '@free-lzj/dsh-agent-import'
  config:
    sources: ['codex', 'claude-code']
    serverDenyList: ['node_repl']
```

安装与完整步骤见[仓库根 README](../../README.md)。

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

全部字段都是 `Volatile`：从插件页或任何 profile 写入都会就地重新导入，不重启进程。

## 行为

- **Codex**：读 `<home>/config.toml` 的 `[mcp_servers.<name>]` 及其 `env` / `http_headers` 子表，以及 `<home>/skills` 下的技能目录。`type` 为 `stdio` 或缺省表示本地程序，`http` / `streamable-http` 表示远端；`env_vars` 从 `process.env` 取值的变量并到 `env` 之下，`bearer_token_env_var` 变成 `Authorization: Bearer` 头。
- **Claude Code**：读 `~/.claude.json` 的用户级 `mcpServers`、同一文件里 `projects.<path>.mcpServers` 的工作区覆盖，以及项目级 `<project>/.mcp.json`；技能目录来自 `<configDir>/skills` 与 `<project>/.claude/skills`。工作区键做路径归一化后匹配。
- **服务器命名**：外部名字归一化到 dsh 的 `[A-Za-z0-9_-]{1,32}` 命名空间；冲突时按声明顺序变成 `name`、`name-2`，超过 32 字符保留原名加六位十六进制摘要。
- **技能优先级**：导入技能注册在 rank 550——低于 dsh 的项目级与用户级技能根，高于随附技能——因此同名的 dsh 技能总是胜出；两个导入源之间按 `sources` 顺序先者胜。
- **失败处理**：读不懂的声明变成一条 `agent-import: …` 警告并跳过，激活照常成功；只有导入的服务器启动失败且 `failOnStartupError: true` 时才会拒绝激活。
- **重导入窗口**：重新导入时先卸载上一代再挂载下一代，因此中间有一瞬间两代都不在；那一瞬发出的请求看不到导入的工具与技能。

## 已知限制

- 这两个包不在 dsh 自带 Web 组合里，必须自行声明；插件页卡片需要伴生包那一行同时在位。
- 插件页不列出已识别的服务器与技能（需要 dsh 自身的 Remote 命名空间）。它们通过工具注册表、技能目录与 `agent-import: …` 日志行可见。
- 外部文件只在激活时读取：Codex / Claude Code 侧改了声明需要重载或重启。
- 不展开两边工具自己的插件市场（如 Codex `plugin.json`）。
- Codex 的 `startup_timeout_sec` 在 dsh 侧没有对应项；Claude Code 的 `sse` 传输不支持。

## 开发

```sh
pnpm run typecheck
pnpm run build     # tsc 出 lib/types，tsdown 出 lib/index.js
pnpm run test      # 在本仓库根目录运行 vitest
```

源码结构：`src/index.ts` 是插件本体（字段声明、导入代际、热重导），`src/adapters/{codex,claude-code}.ts` 各自解析一种外部格式，`src/mcp.ts` 负责把服务器挂到 `mcp-client`，`src/skills.ts` 是技能 provider，`src/toml.ts` / `src/skill-file.ts` / `src/values.ts` 是纯解析与取值工具。
