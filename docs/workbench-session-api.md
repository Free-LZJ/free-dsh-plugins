# 宿主会话服务的真名与入口（实测记录）

> **2026-10-30 更正：本文件早前版本把结论写反了。** 真机证据（mail 的分类会话、console/mail 的
> `session` 动作、真实 Jira 派单、E2E 测试邮件）表明：宿主里**有** `sessionController`，它的
> `create` / `resolveAgent` / `rename` / `followup` 可以从 Host 插件调用；`agents.createSession`
> **不存在**。早前「`sessionController` 只在 Remote 层 / 第三方 Host 插件够不到建会话」的结论作废。
>
> 本节以下的旧段落保留作为踩坑记录，但以本节的当前结论为准。

## 名字的真相（2026-10-30 复核）

| 名字 | 存在？ | 说明 |
|---|---|---|
| `sessions` | ✅ | 会话存储：`create` / `get` / `list` / `fork` / `prepare` / `enter` / `flush` / `liveEntryFor` / `messageProjections` |
| `agents` | ✅ | 代理注册表：`create` / `resume` / `get` / `list` / `register` / `roots` / `requireFactory` / `withInitiator`；**没有 `createSession`** |
| `sessionController` | ✅ | Host 可 `ctx.get('sessionController')`；`create({cwd, agentPreset?})` → `{sessionId}`，`resolveAgent(id)` → `{agent}` 或 `{error}`，另有 `rename({sessionId,title})` |
| `workspaceRegistry` | ❌ | 不存在（工作区归属在会话 header 的 `cwd` 里） |
| `permissionPresets` | ❌ | 不存在（权限是会话上的 `permission/preset` 事件 + 进程级 catalog Remote） |
| `uiSession` / `sessionStatus` | ❌ | 这个版本里没有这两个名字 |

## 建会话的正确顺序（已在 Host 侧跑通）

1. `const { sessionId } = await sessionController.create({ cwd, agentPreset? })`
2. `await sessionController.rename({ sessionId, title })`（没有 `rename` 时退到 `resolveAgent` + `session.append('session/title', …)`）
3. `const resolved = await sessionController.resolveAgent(sessionId)`；`error` 时如实失败
4. `resolved.agent.followup({ role: 'user', content: [{ type: 'text', text }], source })`

事件：`ctx.on('session/event', (session, event) => …)`；助手文本在 `event.data.message.content`，
结束在 `event.type === 'turn/end'` 且 `event.data.reason.kind === 'completed'`。

## 现在的落地位置

- **工作台**：`packages/console/src/workbench/session-port.ts` 把上面四步实现成 `SessionPort`，通过
  `ctx.console.sessions` 交给连接器；`open_session` 工具与真实执行器都走它。
- **看板**：规则动作（或工具）建的会话会 `recordSessionCard` 成卡片，助手输出进卡片日志，
  `turn/end` 把卡片移到「已处理」。
- **mail**：`triage/mount.ts` 的会话端口**优先**用 `ctx.console.sessions`；自己那套 `agents` 端口
  只作为旧宿主兜底。mail 不再拥有建会话逻辑。
- **`readRunningSessions`** 仍从 `agents` 注册表读「正在跑」，因为那是宿主对运行中代理的登记处；
  **创建**不再走 `agents`。

## 曾踩过的坑（保留）

- `ctx.get('agents').createSession is not a function`：`createSession` 原来在
  `dsh-api-session-controller` 插件内部，`agents` 上并没有这个方法；按它写会注册一个永远不触发的
  真实执行器。
- 把 `sessionController` 当成「只在浏览器侧存在」：错的。本机 Host 的 mail 分类会话就是它建的，
  2026-10-30 的真实 Jira 派单和测试邮件也走同一条路。
- 读助手文本只看 `data.content`：宿主事件是 `data.message.content`，只看前者会把模型答案读成空串，
  分类全落 `uncertain`。

## 已知残留

- mail 的模型分类器仍会建一条可见的「邮件分诊」会话（这次只修了读回，没换实现）。要去掉它，下一步
  把分类改成 `ctx.llm` 直调（console 的 `LlmClassifier` 已验证），这是独立改动。
- 「正在跑的会话」列表仍只认 `agents` 注册表；`sessionController` 建的会话是否出现在那里取决于宿主，
  看板卡片不受影响。

## 附：LLM 服务的真实用法（真机验证过）

同一类「名字靠猜」的坑：`llm` 服务没有 `complete()` 这种入口，正确的形状抄自宿主自己的
`dsh-session-title-llm`：

```js
const call = await ctx.llm.prepareCall({ ...route, maxTokens }, signal, (controls) => controls)
for await (const chunk of call.stream({ ...call.config, messages, system, purpose, signal })) {
  if (chunk.type === 'text-delta') text += chunk.text
}
```

provider 名写错会得到 `no adapter registered for provider "..."`。真实的可选值只有两个：

| provider | 凭据来源 |
|---|---|
| `deepseek-account` | 账号登录 |
| `deepseek-official` | API key |

模型名用目录 id（`deepseek-chat` / `deepseek-reasoner` 这类）。本仓的 `LlmClassifier`
（`packages/console/src/workbench/llm-classifier.ts`）用的就是这套，并且已经真机跑通。
