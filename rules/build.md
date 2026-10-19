# 编译、类型与依赖

**何时加载**：修改任意 `package.json`、`tsconfig*.json`、`tsdown.config.ts`，或新增 import / 新依赖时。

## 构建流水

`pnpm run build` = 每包 `tsc -p tsconfig.build.json && tsdown`：

1. `tsc` 产出到 `lib/types/`（同时把本地 import 的 `.ts` 后缀改写成 `.js`）。
2. `tsdown` 以 `lib/types/**` 为输入出两个产物：Node 半边 `lib/index.js`，浏览器半边 `lib/client.js`。

因此 tsdown 的 entry 指向 `lib/types/...`，不要改成 `src/...`。

## 依赖

- 仓库使用 `typescript`、`tsdown`、`vitest` 作为根 devDependencies，包只声明自己真正用到的。
- 运行时由 dsh 提供的包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`）一律写进 `peerDependencies`，**必须带版本范围**；同时写进 devDependencies 以便本地构建与测试。范围要覆盖当前使用的 0.1.x 与 0.2.x 预发布，否则 dsh 启动的兼容性预检会整行禁用插件。
- 新增第三方依赖前先确认：`node:*` 标准库能否替代；仓库内是否已有等价实现；`package.json` 里是否已经装了能做这件事的包。三者皆否才新增。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 只在确有需要放行新发布的包时追加，并保持精确版本。

## 类型

- 不使用 `any` 绕过类型错误；确需窄化时用 `unknown` + 收窄。
- 面向浏览器半边的类型不得引入 `node:*` 类型。
- `tsc --noEmit`（`pnpm run typecheck`）必须零错误，不接受"以前就有"的报错。

## 代码风格

- 注释与措辞跟随现有代码：解释*为什么*，不复述代码。与业务边界、平台约束（例如"为什么这里不能内联 React"）有关的必须留注释。
- 不新增死代码、`// TODO` 占位实现或只被一个调用方使用的抽象。
- 格式化沿用现有文件风格（无分号、单引号、2 空格）；不要为改格式提交无关 diff。
