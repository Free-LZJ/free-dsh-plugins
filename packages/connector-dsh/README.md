# @free-lzj/dsh-connector-dsh

工作台的**内置 DSH 连接器**：把宿主能力（建会话、投递、通知、脚本、MCP、HTTP、大模型）
注册成任务链上的动作。

它是「内置」，但**不是特例**：走的是和第三方连接器完全同一套 `ctx.console.tasks` API。
工作台核心里没有一行代码认识「DSH」这个词。

## 它提供什么

| 动作 kind | 做什么 | 副作用 |
|---|---|---|
| `session` | 在指定工作区**新建**一个会话，把它挂到该目录的工作区下 | 有 |
| `followup` | 投递到**已存在**的会话（会话留在它原来的工作区） | 有 |
| `notify` | 推一条工作台通知 | 无 |
| `script` | 跑一个外部命令（参数不过 shell） | 有 |
| `mcp` | 调一个 MCP 工具 | 有 |
| `http` | 发一个 HTTP 请求（载荷是事件投影，不含正文） | 有 |
| `llm` | 调一次模型，把回答写进节点 | 无 |

还有一个触发器 `console:tool`：`open_session` 工具建好会话后发 `console.tool.invoked`，
它据此把这次派单变成看板上的一条任务（触发 + 会话节点）。

## 会话的两类

- **类型 A：项目会话 / 固定投递**。`session` 在具体目录建会话并
  `workspaceRegistry.attachSession`，所以它出现在侧边栏**对应目录的工作区**下；`followup`
  只投递，不改变既有会话的归属。
- **类型 B：任务内部步骤**（邮件分诊这类）。它们**不建宿主会话**——唯一能隐藏会话的
  `archiveSession` 会把会话锁在 `agent/pre-step` 门闸之外（归档后唤不醒），所以任务内部
  步骤由连接器用无会话执行体完成。它们只出现在卡片链上，不会掉进「未分组」。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉等于不注册这些动作（邮件域动作仍可用） |

## 安装：不需要单独装

它是**库**，不是插件包：没有 Loader 行，也不出现在 DSH 插件目录里。装
`@free-lzj/dsh-console` 时它是依赖，工作台挂载时自己把它注册进任务核心。

```sh
dsh plugin --profile desktop add @free-lzj/dsh-console   # 一次装齐
```

开关在**工作台的连接器页**上，粒度是「参不参与规则」：关掉它只让它不再派活，宿主
本身不受影响；关掉不是卸载。

## 与邮件插件的关系

`@free-lzj/dsh-mail` 只提供**事件**（`mail.received`）、**邮件条件**与**四个邮件域动作**
（`markRead` / `flag` / `move` / `archive`）。规则文件里写：

```yaml
- name: GitHub 工单
  when:
    - kind: from
      any: [notifications@github.com]
  then:
    - kind: markRead      # 邮件连接器提供
    - kind: session       # 本连接器提供
      workspaceTemplate: '{repoRoot}/{repo}'
```

一条规则混用两个连接器的动作，是这套架构的常态：动作 kind 全局唯一，条件词表按连接器
分组。
