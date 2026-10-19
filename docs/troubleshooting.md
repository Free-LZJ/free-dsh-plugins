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

## 浏览器半边的 spec 报 module table / jsdom 相关错误

`vitest.config.ts` 的 `setupFiles` 在 jsdom 环境下安装模块表，`server.deps.inline` 把 `@deepseek-ai/dsh-client-*` 交给 Vite 转换。改动这两处或 `tests/support/` 下的接线后必须跑全量测试。

## 新邮件触发不生效

`mail` 包的同封邮件只处理一次，账本是 `文件夹:UIDVALIDITY:UID`。重连、重启、重复投递都不会二次触发；改了 IMAP 文件夹或账号后 UIDVALIDITY 会变，旧的账本条目自然失效，这是预期行为。
