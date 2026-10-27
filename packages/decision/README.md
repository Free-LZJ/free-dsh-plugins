# @free-lzj/dsh-decision

**库，不是插件。** 来源无关的决策内核：一个规则文件、条件与动作注册表、命中记录、撤销窗口。连接器（邮件、Jira、钉钉…）依赖它，把自己认识的事件和动作注册进来；工作台（`@free-lzj/dsh-console`）读它产出的规则与命中记录。

因为它没有 `apply`、没有浏览器半边、没有 Loader 行，所以**不能 `dsh plugin add`**——它是被别的插件 `import` 的普通依赖。

## 现在有什么

| 模块 | 作用 |
|---|---|
| `createRunStore` | 命中记录的仓：追加、按 id 取、改状态（撤销）、按「先天数后条数」裁剪；文件读坏了回落成空历史 |
| `createPendingStore` | 待撤销队列：按到期时间排队、取消、到期取走；**只取 `undo`，`suggest` 永远等**（否则一条建议会在两分钟后自己执行） |
| `ConditionRegistry` / `ActionRegistry` / `registerAll` | 按 `kind` 注册与取出。泛型参数是连接器填的（配置类型、上下文类型、结果类型），所以内核不认识任何一种具体条件或动作 |
| `writeTextFile` / `readJson` / `serialWriter` | 落盘：临时文件 + rename 的原子写；串行写链（按钮与轮询可能同时在写） |

两份记录都只对**调度字段**有要求：命中记录要 `at`、队列要 `dueAt`/`kind`。事件本身、动作配置、重放需要的摘要都是连接器的字段，内核原样存取——所以抽包没有改动任何一份已有文件的形状。

`Run<TEvent>` 的 `event` 形状由连接器决定：内核只负责把它写下来、读回来。旧形状的兼容也归连接器——`createRunStore` 收一个 `parseEvent`，认不出来的记录被丢掉，认得出来的照常读；下一次落盘就换成新形状，所以迁移是渐进的。

## 为什么单独一个包

决策内核原来长在 `@free-lzj/dsh-mail` 里。连接器会越来越多（Jira / 钉钉 / webhook），内核单独立包之后，新连接器只依赖内核、不依赖工作台，邮件也不必成为「第二个连接器的样板」。判断依据见 [`docs/requirements/feat-workbench/workbench-redesign-analysis.md`](../../docs/requirements/feat-workbench/workbench-redesign-analysis.md) §2.2。

## 已知限制

- **还没有规则解析与编排**：`rules.ts` / `config.ts`（规则文件、kind 校验）与 `triage.ts`（判定流程）还在 `@free-lzj/dsh-mail`，按 P1a 的分片继续搬；注册表与队列已经在这里了。
- **没有版本化迁移**：`runs.json` 的 `version: 1` 只增不减；形状变了靠连接器的 `parseEvent` 兼容旧记录，不写一次性迁移脚本。
