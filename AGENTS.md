# AGENTS.md

本文件只说明**项目结构**与**规则 / 文档索引**，不承载任何具体约束。约束一律在 [`rules/`](rules/)，背景资料在 [`docs/`](docs/)。

## 项目结构

pnpm monorepo。`packages/*` 一个目录就是一个 npm 包，包名统一 `@free-lzj/dsh-<目录名>`，每个包是一个「Host + 浏览器」双面包（只提供 Host 能力的包无 `src/client/`）。

```text
packages/
  agent-import/        # @free-lzj/dsh-agent-import  导入 Codex / Claude Code 的 MCP 服务器与技能
    src/index.ts       #   Host 半边 → lib/index.js
    src/client/        #   浏览器半边 → lib/client.js
    tests/             #   *.spec.ts（Host）/ *.client.spec.tsx（浏览器）
    cordis.patch.yml   #   dsh.bundle 补丁：dsh plugin add 时插入的唯一 Loader 行
    tsdown.config.ts   #   两半的打包形态（平台模块表在这）
  mail/                # @free-lzj/dsh-mail          邮箱面板（接入工作台后从工作台进入）+ 邮件 I/O 服务 + 规则分诊（规则文件、条件/动作注册表、命中记录与撤销、界面顶栏「分诊」视图、发货默认规则与预设）
  console/             # @free-lzj/dsh-console       工作台首页（注意力队列 + 正在跑的会话 + 自动化日志）+ 通知/条目接口；对外导出 panel 契约
    src/index.ts       #   Host 半边：ctx.console 服务（notify 通知 / raise 条目 / log 自动化日志）、通知渠道注册表
    src/client/        #   浏览器半边：注意力队列、插件列表、正在跑的会话、自动化日志、通知中心、设置行
    src/client/contract.ts  # 跨插件契约（消费方 import 的是它）
    src/protocol.ts    #   两半共用的类型（Host 与浏览器都 import）
  web-search-account/  # @free-lzj/dsh-web-search-account  用已登录账号联网搜索（仅 Host 半边）
examples/              # dsh web --patch 用的 overlay 示例
docs/                  # 项目级文档（不是约束）
rules/                 # 开发规则（约束的唯一权威位置）
.github/workflows/     # CI：typecheck → build → test，见 ci.yml
```

根目录文件：`package.json`（脚本与 engines）、`pnpm-workspace.yaml`、`vitest.config.ts`（全部包的测试接线）、`tsconfig.base.json`、`README.md` / `README.en.md`（对外门面）。

单包结构（以 `agent-import` 为准）：`src/`（Host）、`src/client/`（浏览器）、`tests/`、`lib/`（构建产物，gitignore）、`package.json`、`tsconfig.json`、`tsconfig.build.json`、`tsdown.config.ts`、`cordis.patch.yml`、`README.md`。

## 规则索引（`rules/`）

**规则是强制约束。** 动手前先按每份规则头部的 `**何时加载**` 判断是否适用；适用就必须完整读完再行动。

| 规则 | 何时加载 |
|---|---|
| [`rules/rule-maintenance.md`](rules/rule-maintenance.md) | 新增 / 修改 / 删除 / 拆分规则或本文件时；某条规则被绕过、需要补检查时 |
| [`rules/documentation.md`](rules/documentation.md) | 改 README、`docs/**`、`examples/**` 里的说明文字时 |
| [`rules/packages.md`](rules/packages.md) | 新增包，或改任一包的 `src/`、`package.json`、`tsdown.config.ts`、`cordis.patch.yml` 时 |
| [`rules/build.md`](rules/build.md) | 改 `package.json`、`tsconfig*.json`、`tsdown.config.ts`，或新增 import / 依赖时 |
| [`rules/design-patterns.md`](rules/design-patterns.md) | 新增/修改「可替换实现」「多选配置」「跨插件接口」时——通知渠道、导入源、面板接入、存储后端、provider；以及评审这类代码时 |
| [`rules/plugin-ui.md`](rules/plugin-ui.md) | 改任何插件的浏览器半边界面（`src/client/**` 的组件、样式、文案）时；排查 DSH 自身的渲染或布局行为时 |
| [`rules/testing.md`](rules/testing.md) | 改 `src/` 之后、新增路由 / 组件 / 产物契约时 |
| [`rules/git-release.md`](rules/git-release.md) | **执行 Git 写操作之前**；`npm publish` 或改版本号之前（只读 `status`/`diff`/`log` 不需要） |
| [`rules/workspace.md`](rules/workspace.md) | 需要写脚本、抓数据、截图、存调研产物时 |

## 文档索引（`docs/`）

文档是背景与参考，不构成约束；与 `rules/` 冲突时以 `rules/` 为准。

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 双面包为何这样切、Loader 行与 `dsh.bundle`、构建两段流水线的原理 |
| [`docs/development.md`](docs/development.md) | 本地上手、改完如何看效果、常见弯路 |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | 插件不出现、`duplicate loader entry id`、面板不出现等的排查路径 |

其他文档的归属：根 `README.md` / `README.en.md` 是对外门面（是什么、怎么装、怎么发版）；`packages/*/README.md` 是单包的安装、配置与已知限制；dsh 插件机制细节归 `docs/`，不塞进 README。
