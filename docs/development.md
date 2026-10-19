# 本地开发

> 指令与验收标准见 `rules/build.md`、`rules/testing.md`；本文只解释步骤背后的原因和常见弯路。

## 第一次上手

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run test
```

Node 版本按根 `package.json` 的 `engines`（`^22.19 || >=24`）；pnpm 版本由 `packageManager` 固定（`11.7.0`），CI 里显式 `npm i -g pnpm@11.7.0` 安装同版本。

## 改完怎么看到效果

包本身要装进 dsh 才能看到，有两种方式：

```sh
# 方式一：装进 profile（会插入 Loader 行）
dsh plugin --profile web add "<本仓库绝对路径>/packages/<包名>"

# 方式二：不改 profile，用 overlay 启动
dsh web --patch examples/agent-import.cordis.yml
```

- 跑了 `dsh web` 的，Host 半边改动**需要重启**（启动时一次性 `import()`）；浏览器半边刷新页面即可，但前提是产物已重建（`pnpm run build`）。
- 桌面端用 `--profile desktop`，它自带一份 dsh 运行时，profile 与 CLI 不通用。
- 开发 dsh 主仓库本身时可让本仓库产物被主仓库的 profile 启动夹具消费，此时改动 Host 半边需要重启 `dsh`。

## 常见弯路

**产物是旧的。** `lib/` 不会自动重建。所有行为异常先跑一次 `pnpm run build` 再判断。

**测试显示 skipped。** 那是产物契约测试找不到 `lib/`，不是通过。先 build 再 test。

**Windows 上过了、Linux 上不过（或反过来）。** adapter 类 spec 里有 `C:`、`D:` 形式的 home 夹具，在 Linux 会被当作相对路径。以 CI（windows-latest）结果为准。

**只改了包 README 但 npm 上没变。** npm 包页的 README 来自 tarball，改 README 需要重发版本。

**两个包都想提供同一个搜索 provider / 面板 id。** 先查 `docs/troubleshooting.md` 的重复 id 一节，再决定是否真的需要。

## 依赖策略

dsh 自家包一律走 peerDependencies（带范围）+ devDependencies（本地构建用）。新增第三方依赖前先看 `rules/build.md` 的取舍顺序：`node:*` 标准库 → 仓库内已有实现 → 已装的包 → 才新增。
