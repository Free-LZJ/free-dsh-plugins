# 测试

**何时加载**：改动任一包的 `src/` 后，以及新增包、新增 Host 路由、新增浏览器组件、修改产物契约（`package.json` 的 `dsh` 字段、`cordis.patch.yml`、`tsdown.config.ts`）时；需要在真实运行的 DSH 里验证插件行为时。

## 命令与顺序

```sh
pnpm run typecheck
pnpm run build      # 必须先于 test
pnpm run test       # vitest run
```

**先 build 再 test**：产物本身有契约测试（注册 id、`dsh.client` 声明、`exports["./client"]`、浏览器入口不含 Host 半边取值）。没有 `lib/` 时其中一条会显示 skipped —— 看到 skipped 就说明你漏了 build，不是通过。

CI 在 `windows-latest` 上跑同样三步（`.github/workflows/ci.yml`，Node 24 + `pnpm install --frozen-lockfile`）。

## 提交前：CI 同款检查

改完 `src/` 或任何跨包代码后，提交前必须完整跑一遍上面三步，以**退出码**为准：输出里出现 `error` 字样不算通过，`exit 0` 才算。三条命令顺序不能换。

CI 红了先定位，不要猜：

```sh
gh run list --limit 5                      # 找到失败的 run id
gh run view <id> --log-failed              # 看第一条 ##[error]，那才是根因
```

### 干净 checkout 必须能 typecheck

本地 `packages/*/lib/` 是 gitignore 的构建残留。它存在时 typecheck 可能通过一条**干净 checkout 过不了**的解析，CI 因此变红——本地全绿不代表 CI 绿。

- 新增任何跨包 import（尤其是子路径导出，如 `@free-lzj/dsh-console/contract`）时，必须在 `tsconfig.base.json` 的 `paths` 里加一条指向该包**源码**的映射，写法与既有的 `@free-lzj/dsh-decision` 一致。包的 `exports` 指向 `lib/` 里的构建产物，干净 checkout 上还没有它。
- 改完删掉被依赖包的 `lib/` 再 typecheck 一次，证明干净态能过：

```sh
Remove-Item -Recurse -Force packages/console/lib   # 换成实际被 import 的那个包
pnpm run typecheck
```

- 各包的 `tsconfig.build.json` 会清空 `paths`、改解析构建产物；新增映射后不要动这一步，构建仍必须走 `lib/`。`tests/**` 里 adapter 类 spec 断言 Windows 盘符路径（`C:`、`D:` 夹具），不要在本地以 Linux 结果判断通过与否。
- 验证一律走 `pnpm run typecheck`（脚本带 `--noEmit`）。不要直接 `tsc -p packages/<包>/tsconfig.json`：它会把 `.js` / `.d.ts` / `.map` 吐进 `src/`，污染工作区，还让后续 typecheck 解析到这些残骸。

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
- 夹具里的临时目录一律用 `realpathSync.native(...)`（或 `await realpath(...)` 的 `.native` 等价物）取真实路径：`realpathSync` **不展开 8.3 短名**。CI 的 `TEMP` 是 `C:\Users\RUNNER~1\...`，git 返回的是长名，夹具停在短名会让 `toBe` / `samePath` 在 CI 全红、本地全绿。
- 改动了 `packages/agent-import/tests/support/`、`packages/mail/tests/support/` 这类共享接线（模块表、运行时、jsdom 注入）时必须跑全量 `pnpm run test`，而不是单文件。

## 运行时验证：另开第二实例

要在真实界面里看插件效果时，**另起一个 DSH 实例**，不要碰用户当前在用的那个：

```sh
pnpm run build
dsh --profile web --port 0 --no-open          # 0 = 系统挑空闲端口；也可以给个具体端口
# 或 overlay 方式，不写进任何 profile
dsh --profile web --patch examples/agent-import.cordis.yml --port 0 --no-open
```

- 端口必须与用户当前实例（见运行时上下文里的 Web GUI URL）不同，`--port 0` 最省事。
- 不重启、不 `dsh plugin add` 进用户 profile 来验证；用户正在用的实例归用户。
- Host 半边改动仍需重启实例（新的第二实例天然满足）；浏览器半边刷新页面即可。
- 验证完关掉第二实例，别留后台进程。
