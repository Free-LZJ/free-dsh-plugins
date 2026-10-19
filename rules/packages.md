# 包与双面包结构

**何时加载**：新增包、改动任一包的 `src/`、`package.json`、`tsdown.config.ts`、`cordis.patch.yml` 或 `src/client/**` 中的代码时。

仓库形态：pnpm monorepo，`packages/*` 一目录一包，包名统一 `@free-lzj/dsh-<目录名>`。

## 两半的边界

| 半边 | 源码入口 | 产物 | 约束 |
|---|---|---|---|
| Host | `src/index.ts` | `lib/index.js`（ESM，Node） | 可以读文件系统、建长连接、开 HTTP 路由、读写 dsh 设置命名空间 |
| 浏览器 | `src/client/index.ts` | `lib/client.js`（module-table 闭包工厂） | 只能通过 Host 路由 / 设置命名空间取数据；**不得从 `src/**`（Host 半边）导入运行时代码**，只能导入类型 |

- 浏览器产物只从 `src/client/**` 打包；`src/client/**` 一旦 import 了 Host 模块的运行时值，`yaml`、IMAP 客户端等 Node 依赖就会被内联进浏览器包。有对应契约测试，破坏了会失败。
- 平台模块（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`）必须在 `tsdown.config.ts` 的 `PLATFORM_MODULES` 里保持 external，禁止内联出第二份 React 或第二个插槽注册表。
- 只为 Host 提供能力的包（没有浏览器半边）不写 `src/client/`、不声明 `dsh.client`，并在包 README 与根 README 的包表里标注"仅 Host 半边"。

## Loader 行

- 包必须在 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，让 `dsh plugin add` 自动插入那唯一一行。
- `cordis.patch.yml` 里的 `id` **不是自由命名**：它同时是设置命名空间、路由前缀或面板 id。改名等于破坏已有用户的 profile，因此任何包改 id 都按破坏性变更处理（须升 minor 并在包 README 写迁移步骤）。
- 每个包只允许一条 Loader 行。此前拆成两个包（Host 包 + `-client-ui-settings-*` 包）的形态已废弃，不要恢复。

## 新增一个包的检查清单

1. 目录 `packages/<名>/`，复制同仓库现有包的 `tsconfig.json`、`tsconfig.build.json`、`tsdown.config.ts`（只改 `PACKAGE_NAME`、entry、平台模块表——除非确有新平台模块，否则不改表）。
2. `package.json` 的 `files` 必须包含 `lib/index.js`、`lib/client.js`（若有两半）、`lib/types/**/*.d.ts`、`cordis.patch.yml`、`README.md`；`exports` 同时导出 `.` 与 `./client`。
3. `cordis.patch.yml` 写一条 `insert`，并注明 id 不可改名的原因。
4. 写 `packages/<名>/README.md`（安装、配置字段表、能力与已知限制）与 `tests/*.spec.ts`。
5. 同步根 `README.md` 与 `README.en.md` 的包表、`AGENTS.md` 的项目目录表。
