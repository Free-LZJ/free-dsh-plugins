# 排障

> 属于参考信息，不是约束。发现新故障请回流到本文，不要把排障步骤塞进 README（见 `rules/documentation.md`）。

## 插件装了但完全不出现

按顺序排查：

1. **dsh 启动日志有没有禁用整行**。stderr 出现 `dsh: disabling profile plugin row "<id>": …` 表示兼容性预检把该行禁用了 —— 通常是运行时版本不在 peer 范围里。用 `dsh plugin --profile <profile> allow-version <包@版本> --dsh-version <运行时版本> --accept-risk` 对该精确版本授权。
2. **profile 选错了**。`dsh web` 用 `web`，桌面端用 `desktop`，两者不通。
3. **产物没重建或没安装**。`dsh plugin add <绝对路径>` 装的是当时的 `lib/`，改了源码要重新 `pnpm run build` 并重装（或重新指向同一路径）。
4. **Host 半边改了没重启**。Host 半边只在启动时 `import()` 一次。

## `duplicate loader entry id "<id>" (2 rows)`

包自带 `dsh.bundle`，`dsh plugin add` 已经插入了 Loader 行。此时又在 profile 补丁里手写了同 id 的 `- insert:`，于是同 id 两行，插件市场预检把安装/更新整体回滚。

修法：删掉手写的 `- insert:`；要传配置就写**同 id 的 override（无 `insert`）**：

```yaml
- id: mail          # 不带 insert
  config:
    ...
```

## 设置页 / 面板不出现，但 Host 那半边正常

- 浏览器半边依赖 `package.json` 的 `dsh.client` 声明与 `exports["./client"]` 指向 `lib/client.js`；任一缺失，页面就找不到该 bundle。
- 页面里出现两份 React 或两个插槽注册表，通常是 `tsdown.config.ts` 的 `PLATFORM_MODULES` 少了某个平台模块，导致它被内联。改 `PLATFORM_MODULES` 前先确认该模块确实由页面 module table 提供。
- 浏览器半边 import 了 Host 半边的运行时值，会把 Node 依赖打进浏览器包并大概率在页面里抛错。契约测试会拦；看到这个报错就回到 `src/client/**` 把 import 改成只取类型。

## `Property 'slots' does not exist on type 'Context'`（或 `PropsRuntime<'…'>` 约束成 `never`）

现象：源码看起来没问题，`pnpm run typecheck` 报上面两条之一，且换回上一版依赖就消失。

原因不在代码：**同一个包在 pnpm 里有两份物理副本**。DSH 的服务（`ctx.slots`、`ctx.locale`、`ctx.workspace`…）和插槽表（`SlotMap`、`LocaleNamespaceMap`）都是 TypeScript 的模块增强（`declare module '@deepseek-ai/cordis'` / `'@deepseek-ai/dsh-client-ui-slots'`），增强只并入**同一份物理模块**。当某个包钉 0.2.x 预发布、其他包还是 0.1.x 时，pnpm 的隐藏提升目录里可能只有旧版，于是 `dsh-client-locale` 之类的包把增强写进旧副本，你自己的文件读的是新副本 —— 服务"不存在"，`SlotMap` 是空的。

判断：

```powershell
# 两份以上就是这个问题
Get-ChildItem node_modules\.pnpm -Directory | Where-Object Name -like "*dsh-client-ui-slots*"
```

三种解法，按代价从低到高：

1. **给这个包加路径映射**（`worktree` 包就是这么做的）：`tsconfig.json` 里把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 指到本包自己的 `node_modules` 那一份，让所有增强落到同一模块。
2. **整仓统一版本**：所有包的 `@deepseek-ai/dsh-*` 开发依赖升到同一个 0.2.x 预发布，并统一 `@deepseek-ai/cordis` 版本（各包 peer 的 `~4.0.5` 说明 4.0.5 是共同可满足的版本）。
3. 只对某个包做 `pnpm.overrides` —— 会牵连别的包，最后仍要回到方案 2。

统一版本后可以把方案 1 的 `paths` 删掉；保留也不会错，只是多一层说明。

## 本地装成 `link:` 后整行不激活

现象：`dsh plugin add "<本仓库绝对路径>/packages/<包名>"`（或插件市场里装目录）返回安装成功，但激活那一步打印

```text
dsh: warning: 1 entry did not activate
<id> (<包名>): failed to import: Error: ENOENT: no such file or directory,
lstat '<profile>\node_modules\node_modules'
```

`cordis_inspect_query(Config)` 里该行是 `inactive`，页面和工具都不出现。已观察到的范围：桌面端 profile（`nodeLinker: hoisted`）、包带第三方运行时依赖时。同一个包换成 tarball 安装就是 `applied`。

绕过（推荐）：**用 `pnpm pack` 出的 tarball 而不是目录**。

```sh
cd packages/<包名>
pnpm pack --pack-destination ../../.tarballs
dsh plugin --profile desktop add "<本仓库绝对路径>/.tarballs/<...>.tgz"
```

tarball 走普通安装路径（`node_modules` 下的实体目录），不进「linked roots」那条链路，因此没有这个现象。

改完源码重启迭代更快的一条：只对**浏览器半边**生效的改动刷新页面即可；Host 半边改动仍需重装 + 重启。

## 浏览器半边的 spec 报 module table / jsdom 相关错误

`vitest.config.ts` 的 `setupFiles` 在 jsdom 环境下安装模块表，`server.deps.inline` 把 `@deepseek-ai/dsh-client-*` 交给 Vite 转换。改动这两处或 `tests/support/` 下的接线后必须跑全量测试。

## 新邮件触发不生效

`mail` 包的同封邮件只处理一次，账本是 `文件夹:UIDVALIDITY:UID`。重连、重启、重复投递都不会二次触发；改了 IMAP 文件夹或账号后 UIDVALIDITY 会变，旧的账本条目自然失效，这是预期行为。
