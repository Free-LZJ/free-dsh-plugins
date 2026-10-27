# 宿主会话服务的真名与入口（实测记录）

> 这份文档不是约束，是一次**实测**的记录。写它是因为同一个错误已经被重复相信过一次：
> 两个包按 `sessionController` / `workspaceRegistry` 这两个名字写代码，而宿主里根本没有
> 这两个服务——它们永远不会就位，代码只会静默地什么都不做。

## 怎么测的

临时 profile（`dsh plugin --profile <tmp> add link:<本仓>/packages/console`），在 console 的
`apply` 里挂一段探针，把 `ctx.get(name)` 的**自有属性**与**原型成员**写进文件
（`dsh web` 进程的 `ctx.logger` 输出在该场景下看不到，所以落盘而不是打日志）。测完删掉探针
和临时 profile。

环境：harness 0.2.x（`E:\Program Files\deepseek\…\app.asar\dsh`），2026-10。

## 名字的真相

| 名字 | 存在？ | 说明 |
|---|---|---|
| `sessions` | ✅ | 会话存储与服务：`create` / `get` / `list` / `fork` / `prepare` / `enter` / `flush` / `liveEntryFor` / `messageProjections` |
| `agents` | ✅ | 代理服务：`create` / `resume` / `get` / `list` / `register` / `roots` / `requireFactory` / `withInitiator` … |
| `sessionController` | ❌ | **只在 Remote 层**：`dsh-api-session-controller` 把它的方法通过 typert 暴露给浏览器，宿主上下文里没有同名的 cordis 服务 |
| `workspaceRegistry` | ❌ | 不存在（工作区归属在会话 header 的 `cwd` 里） |
| `permissionPresets` | ❌ | 不存在（权限是会话上的 `permission/preset` 事件 + 进程级 catalog Remote） |
| `uiSession` / `sessionStatus` | ❌ | 这个版本里没有这两个名字 |

`Object.keys(service)` 只能看到 `counter` / `store` / `projections` 这类字段——**方法在原型上**。
`Object.getOwnPropertyNames(Object.getPrototypeOf(service))` 才看得到 `create` / `list` / `get`。

## 建会话这件事，第三方插件其实够不到（第二轮实测，2026-10）

按上一版写的 `ctx.get('agents').createSession({cwd})` 去接，真机跑出来是：

```
正在为「真实执行器冒烟」创建会话… | 创建会话失败：agents.createSession is not a function
```

去看 asar 才明白：`createSession` **不在 `agents` 服务上**，它属于
`SessionController` 插件内部 new 出来的 `ApiSessionAgentController`：

```js
// dsh-api-session-controller/lib/index.js
class SessionController {                      // Loader 行：id `sessionController`
  constructor(ctx, config, internals = {}) {
    super(ctx, "sessionController", { namespace: "session" })
    this.agents = new ApiSessionAgentController(ctx)      // ← createSession / resolveAgent 在这
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
```

也就是说：

- `sessionController` 是**这个插件注册的 Remote 服务名**（`super(ctx, "sessionController")`），
  它的方法通过 typert RPC 暴露给浏览器，**不是**普通的 cordis 方法集合；
- `agents.createSession` 在宿主里不存在，除非该插件被组合进来——而即便组合了，拿到的也是
  Remote，不是可以直接 await 的本地方法；
- 宿主自己建会话用 `agents.create({ sessionId, agentOptions, meta: { cwd }, setup })`，
  其中 `agentOptions()`（模型选择 / 工具 / 预设）是控制器内部的组装，第三方复刻不了。

**结论：本版本没有给第三方 Host 插件留「建一个会话」的公开缝。** 想在 Host 侧做到，只有两条路：
(a) 走 typert 从宿主调用 Remote（要摸 `ctx.typert` 的调用语法）；(b) 让**浏览器半边**用与
GUI 相同的 RPC 建会话，再把 sessionId 交回 Host 绑卡片。两条都要单独验证，别靠猜。

当前的落地方式：`createHarnessRunner` 先检查 `agents.createSession` 是不是函数，不是就
**不注册真实执行器**并写明原因——而不是注册一个派单时才抛 `TypeError` 的壳。

## 真正的入口（原记录，保留）'

- 建会话 + 起代理：`ctx.get('agents').createSession({ cwd, agentPreset?, sessionId? })`
  （`dsh-api-session-controller` 的 Host 侧就是这么用的：`await this.ctx.agents.createSession(...)`）
- 读会话：`ctx.get('sessions').get(id)` / `.list()`
- 收尾：`agents.createSession` 返回的句柄里带有代理与会话（`created(agent)`），停止走代理自己的
  生命周期，而不是臆造的 `archive`

## 受影响的地方（都还没修）

1. `packages/console` 的 `readRunningSessions`：读 `sessionController` → 永远返回空，
   所以聚焦页「正在跑的会话」一直是空的。**这是用户可见的 bug，不是「还没接」**。
2. `packages/console` 的真实会话执行器：`inject(['sessionController'])` 永远不会触发。
3. `packages/mail` 的会话端口（`triage/mount.ts` 的 `sessionPort()`）：同一批名字，
   所以它的 `session` 动作在真实部署里从来没工作过。

## 修的顺序

1. 先给 `sessions` / `agents` 写一层**窄端口**（本仓已有的做法：结构化声明 + `ctx.get`），
   只声明用到的那几个方法，不要 import 宿主类型（可选依赖，见 `rules/design-patterns.md`）。
2. console 与 mail 都改成用这层端口；两边各自补「服务缺失时的行为」测试。
3. 再回临时 profile 做真机验证：派单 → 真会话建起来 → 日志流回卡片 → `turn/end` 收尾。
4. 最后更新本文档与两个包的 README，把「已修」写进去。
