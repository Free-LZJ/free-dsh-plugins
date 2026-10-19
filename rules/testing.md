# 测试

**何时加载**：改动任一包的 `src/` 后，以及新增包、新增 Host 路由、新增浏览器组件、修改产物契约（`package.json` 的 `dsh` 字段、`cordis.patch.yml`、`tsdown.config.ts`）时。

## 命令与顺序

```sh
pnpm run typecheck
pnpm run build      # 必须先于 test
pnpm run test       # vitest run
```

**先 build 再 test**：产物本身有契约测试（注册 id、`dsh.client` 声明、`exports["./client"]`、浏览器入口不含 Host 半边取值）。没有 `lib/` 时其中一条会显示 skipped —— 看到 skipped 就说明你漏了 build，不是通过。

CI 在 `windows-latest` 上跑同样三步。`tests/**` 里 adapter 类 spec 断言 Windows 盘符路径（`C:`、`D:` 夹具），不要在本地以 Linux 结果判断通过与否。

## 命名与位置

- 测试放 `packages/<包名>/tests/`，文件名与被测源文件同名：`src/x.ts` → `tests/x.spec.ts`。
- 浏览器半边（`src/client/**`）的测试文件名必须带 `.client.` 段：`tests/x.client.spec.tsx`。裸 `x.spec.ts` 用于 Host 半边。
- 组件测试用 `.tsx` + `@testing-library/react`；jsdom 环境由 `vitest.config.ts` 统一配置，不要在单个文件里另设环境。
- 夹具（`.eml` 等）放 `tests/` 下，不要放仓库根。

## 要求

- 修 bug 必须留下一个在修复前会失败、修复后通过的回归测试。
- 新增 Host 路由要有路由层测试（成功路径 + 至少一条拒绝/错误路径）；新增解析或状态机要有边界用例。
- 不以"覆盖率数字"为目标；不为了覆盖率给一行 getter 写测试。
- 测试不得依赖真实网络、真实邮箱、真实 `~/.codex` / `~/.claude`；全部用临时目录与夹具替代。
- 改动了 `packages/agent-import/tests/support/`、`packages/mail/tests/support/` 这类共享接线（模块表、运行时、jsdom 注入）时必须跑全量 `pnpm run test`，而不是单文件。
