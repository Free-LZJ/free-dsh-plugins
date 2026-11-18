# BrowserSkill fork

本仓库 `vendor/browser-skill` 是 [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)
在 `dsh-plugin-v0.5.0`（提交 `361da1d`，protocol **1.9**）上的 fork。它服务于
[`packages/browser-use`](../packages/browser-use/README.md)：上游的 `borrow` 会把用户的标签页
搬进独立的 Agent Window，这个 fork 改成**就地接管**。

## 为什么改

上游的模型是「一个会话一个 Agent Window」：`bsk_session start` 新建窗口，`tab borrow`
把用户标签页 `chrome.tabs.move` 进那个窗口。用户看到的是：`@` 一下多一个窗口，
再操作时页面从自己窗口里消失、跑到另一个窗口去。

这个 fork 把两件事拆开：

| 行为 | 上游 | 本 fork |
|---|---|---|
| 借用用户标签页 | `chrome.tabs.move` 进 Agent Window | 不动页面，会话改锚定到用户窗口 |
| 会话的 Agent Window | 任务页面的容器 | 创建后最小化，只作空壳，`stop` 时关闭 |
| 借用确认弹窗 | 默认每次确认 | 默认关闭（页面不再被搬走，没有可确认的破坏） |

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `apps/extension/src/session-manager/manager.ts` | `SessionContext.ownsWindow` / `orphanWindowId`；`start()` 后最小化窗口；`adoptUserWindow()`；`stop()` 只关自己的窗口 |
| `apps/extension/src/session-manager/agent-window.ts` | `AgentWindowApi.minimize()` |
| `apps/extension/src/session-manager/event-handler.ts` | 就地接管后，标签页在用户窗口内移动只解绑该页，不结束会话 |
| `apps/extension/src/tools/tabs.ts` | `BORROW_IN_PLACE`；借用跳过 `tabs.move`；成功后在流程**最后**改锚定；`tab_return` 只放开控制；`tab_list` 的 scope 判定区分「已接管窗口里的任务页」和「用户自己的页」 |
| `apps/extension/src/lib/interaction-preferences.ts` | `confirmTabBorrow` 默认 `false` |

`crates/`（CLI、daemon、protocol）一行未改：fork 只动扩展，因此不需要 Rust 工具链，
也不需要替换用户机器上的 `bsk.exe`。

## 构建与加载

```sh
cd vendor/browser-skill
pnpm install --frozen-lockfile
pnpm --filter @browser-skill/extension compile   # tsc --noEmit
pnpm --filter @browser-skill/extension build     # → apps/extension/dist/chrome-mv3
```

在 Edge 打开 `edge://extensions`，开启「开发人员模式」，**移除或停用商店版 BrowserSkill**，
再「加载解压缩的扩展」指向 `apps/extension/dist/chrome-mv3`。

扩展必须和已安装的 `bsk` CLI 协议对齐：daemon 1.9 会踢掉 2.0 的扩展
（`daemon.log` 里是 `kicked: protocol major mismatch`）。上游 `main` 已经是 2.0，
所以这里锁在 `dsh-plugin-v0.5.0`；升级 `bsk` 时两者要一起升。

## 验证过的行为

在独立 Edge 实例（临时 profile、加载本 fork）上实测：

1. `bsk session start` → 窗口创建后最小化；
2. `bsk tab borrow <用户 tab>` → 返回的 `agent_window_id` 变成用户窗口，标签页的
   `window_id` 不变、`scope` 从 `user` 变 `agent`；
3. `bsk sync` → 读到了用户窗口里那个页面的 VOM；
4. `bsk click` → 页面原地跳转（`example.com` → `iana.org`），标签页没有换窗口。

## 已知问题

- **写操作回执不干净**：借来的页面在第一次写操作时会返回
  `permission_denied / reason: control_context_invalid`，但 `effect_state: unknown` 且动作已经生效。
  协作控制器（`cooperation/controller.ts`）在窗口锚定变化后仍按旧 epoch 校验。
  按工具约定，`effect_state: unknown` 时**不要重放**，先 `sync` 核对页面再决定下一步。
  修它需要继续梳理 controller 的窗口/epoch 语义。
- **Agent Window 会留一个最小化空壳**：adopt 时不关闭窗口，否则协作控制上下文会失效；
  `stop` 时才真正关掉。任务栏可能短暂出现一个最小化的空窗口。
- **两个 MCP 子进程**：插件自己的（列标签页）和 dsh MCP client 的（给模型工具）各一条，
  共用同一个 daemon 会话。合并它们需要 dsh 侧把 MCP 客户端交给插件复用。

## 上游同步

重新取上游：

```sh
git clone --depth 1 --branch dsh-plugin-v0.5.0 https://github.com/Tencent/BrowserSkill.git /tmp/bsk
```

把上面 5 个文件里的 fork 改动重新应用即可；改动都用注释标了 `fork` 或写明原因。
