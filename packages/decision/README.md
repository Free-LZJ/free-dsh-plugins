# @free-lzj/dsh-decision

**库，不是插件。** 来源无关的决策内核：一个规则文件、条件与动作注册表、命中记录、撤销窗口。连接器（邮件、Jira、钉钉…）依赖它，把自己认识的事件和动作注册进来；工作台（`@free-lzj/dsh-console`）读它产出的规则与命中记录。

因为它没有 `apply`、没有浏览器半边、没有 Loader 行，所以**不能 `dsh plugin add`**——它是被别的插件 `import` 的普通依赖。

## 现在有什么

| 模块 | 作用 |
|---|---|
| `createRunStore` | 命中记录的仓：追加、按 id 取、改状态（撤销）、按「先天数后条数」裁剪；文件读坏了回落成空历史 |
| `writeTextFile` / `readJson` / `serialWriter` | 落盘：临时文件 + rename 的原子写；串行写链（按钮与轮询可能同时在写） |

`Run<TEvent>` 的 `event` 形状由连接器决定：内核只负责把它写下来、读回来。旧形状的兼容也归连接器——`createRunStore` 收一个 `parseEvent`，认不出来的记录被丢掉，认得出来的照常读；下一次落盘就换成新形状，所以迁移是渐进的。

## 为什么单独一个包

决策内核原来长在 `@free-lzj/dsh-mail` 里。连接器会越来越多（Jira / 钉钉 / webhook），内核单独立包之后，新连接器只依赖内核、不依赖工作台，邮件也不必成为「第二个连接器的样板」。判断依据见 [`docs/requirements/feat-workbench/workbench-redesign-analysis.md`](../../docs/requirements/feat-workbench/workbench-redesign-analysis.md) §2.2。

## 已知限制

- **只有持久化与记录**：规则解析、条件/动作注册表、编排还在 `@free-lzj/dsh-mail`（`src/triage/`），按 P1a 的分片逐步搬过来。
- **没有版本化迁移**：`runs.json` 的 `version: 1` 只增不减；形状变了靠连接器的 `parseEvent` 兼容旧记录，不写一次性迁移脚本。
