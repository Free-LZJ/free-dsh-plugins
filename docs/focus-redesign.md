# 聚焦页：现状、生态调研与重做待办

> 本文是调研与待办，不是约束。约束见 `rules/plugin-ui.md`、`rules/design-patterns.md`。
> 状态：**只读分析完成，未实施**（本轮只新增本文，未改 `packages/**`）。核实时间 2026-11-06。

## 结论先说

现在的「聚焦」不是聚焦，是**「此刻有 agent 在跑」的第三份列表**：侧边栏状态点已经说过一次，首页「正在跑的会话」说过第二次，聚焦页是第三次。

用户要的是另一种东西：**我这一轮决定在做哪几条、它卡在哪一步、不离开页面就能推一步**。这需要两样当前实现都没有的东西——宿主会话状态机（`useSessionStatus`）和页内动作（回复 / 审批 / 停止 / 换模型）。现在的实现只有「列表 + 跳走」，且列表的定义还恰好把「在等你」的会话漏掉。

## 现状

### 它能显示什么

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 进行中 | 会话标题（无标题退到短 id）、工作目录、「进入会话」按钮 | `props.running()`，`focus.tsx:62`、`focus.tsx:94-96`、`focus.tsx:32-36` |
| 等的是 | 该会话的待处理条目标题（可多条） | `shell.tsx:252-254`，从**通知记录**里 filter `state === 'new' && sessionId === 本行` |
| 待回写 | 看板里 `awaitingConfirmation` 的卡片 + 进入按钮 | `focus.tsx:150-188`，`WorkbenchCard` |
| 页面外壳 | 标题、说明、视图导航、通知按钮 | `shell.tsx:235-262`，与首页共用 `WorkbenchTop` |

### 数据依赖

- **Host 半边**：`/dsh-console/state` 里的 `running`，由 `readRunningSessions()`（`packages/console/src/index.ts:333-345`）从 **`agents` 注册表**读出，标题靠 `sessions` / `sessionTitle` 两个可选服务补（`protocol.ts:195`）。
- **浏览器半边**：`link.getSnapshot()` 的工作台快照（通知 / 计数 / 日志）、`workbenchFace`（看板动作，`client/index.ts:146-161`）。
- **可选服务 `uiWorkspace`**：`client/index.ts:100-106` 用 `ctx.inject(['uiWorkspace'])` 拿 `openSession`，没装就只是少一个按钮。
- **页面注册**：`CONSOLE_FOCUS_PANEL_ID = 'console-focus'`，作为第二个 `main` 槽键控条目（`protocol.ts:217`、`client/index.ts:321-328`），与首页 `main:console` 并列。

### 为什么「不真」：三个缺陷

**D1｜列表的定义和「聚焦」的语义相反。**
`runningSessionsOf()`（`packages/console/src/workbench/harness-session.ts:245-256`）只收 `agent.isActive() === true`，即**此刻正在驱动一轮**的 agent。一条会话正在等你审批 / 等你回答时，agent 不活跃 → **它恰好从聚焦页消失**。聚焦页最该显示的那一行，被数据源的定义排除了（`focus.tsx:62`）。

**D2｜「等的是」是通知的副产物，不是会话状态。**
`shell.tsx:252-254` 把「等的是什么」实现成：从 console 自己的通知记录里筛 `sessionId` 匹配的 `new` 条目。而通知是**插件自己 raise 的**（`ctx.console.notify`），宿主从不会替一条会话发出「它在等我」的通知——所以这一栏在没有插件主动带 `sessionId` 报信时恒为空。

真正的状态就在手边：`useSessionStatus`（`packages/client/ui-session/src/client/index.ts:59-72`）给出 `running` / `pendingInteraction`（等待审批、等待回答、计划待审）/ `completionUnread` 三件事，且它是 `GlobalStandardProps`（同文件 `:157-164`），按 `packages/client/ui-slots/src/index.ts:232-253` **投递给每一个槽组件**——聚焦页在运行时其实已经拿到它，只是类型没接：`RunningSession`（`protocol.ts:116-121`）故意只有 `sessionId` / `title` / `cwd` 三个字段。

**D3｜只能跳走，不能在页内推一步。**
整页唯一的动作是「进入会话」（`focus.tsx:117-119`），走 `openSession`（`client/index.ts:299-309`），而它本身是**可选**服务 `uiWorkspace` 的能力：没装、或挂得比本页晚，按钮直接不渲染（`focus.tsx:64`）。点下去聚焦页卸载、跳到会话页——「看一眼谁在等我」的代价是离开当前页。

同时，本包其实已经有一整套更合适的会话模型：`WorkbenchSession`（`protocol.ts:410-418`，带 `status` + `logs`）和它的 `interrupt` / `pause` / `resume` / `end` 动作（`client/index.ts:155-158`，Host 侧 `workbench/board.ts`）。聚焦页一个都没用，反而读了更弱的那套 `RunningSession`——**同一个包里两套会话概念并存**，聚焦页用的是差的那套。

**附加｜零测试覆盖。** `packages/console/tests/` 下没有 `FocusPage` / `FocusShell` 的任何断言。

## 生态调研（已联网核实）

| 仓库 | 真实存在 | Star | 最近推送 | npm 包 | README 声明的能力 |
|---|---|---|---|---|---|
| [`Fan-sx/dsh-session-focus`](https://github.com/Fan-sx/dsh-session-focus) | 是 | 0 | 2026-10-30 | **有**：`dsh-session-focus@0.1.2`（npm 上 0.1.0 / 0.1.2，2026-10-30 更新） | 焦点标记三态（无 / 进行中 / 挂起）点会话标题前 16px 格子循环；工作区折叠后仍可见条数；侧边栏底部「● N 条在手上」；面板页跨工作区按状态分组，状态读原生 `useSessionStatus`；**纯客户端**，标记存 `localStorage` + `BroadcastChannel`，Host 半边无路由 / 无工具 / 无服务；要求 DSH `>=0.2.0-rc.2 <0.3.0`，peer 依赖只有 cordis |
| [`caichangzhan/dsh-topic-wall`](https://github.com/caichangzhan/dsh-topic-wall) | 是 | 0 | 2026-10-29 | **无**：npm 上 `dsh-topic-wall` 404（仅本地目录 / tarball 安装） | 多会话「对话墙」：置顶 / 进行中 / 聊天集合三段卡片；读真实历史；**卡内回复**（`session/prompt`、`session/cancel`）、排队消息原地编辑与转向、**审批与单选题直接出现在卡片底部**、每卡独立模型下拉、每卡 ⋯ 菜单（打开 / 重命名 / 分支 / 归档）；三套主题。依赖 `sessions` / `uiSession` / `uiWorkspace` / `modelDirectories`；自述无自动化 UI 测试 |
| [`CH3SH-LC/dsh-team-workbench`](https://github.com/CH3SH-LC/dsh-team-workbench) | 是 | 1 | 2026-10-17 | **无**：`package.json` 是 `"private": true` 的 `@local/dsh-team-workbench@1.0.0`（npm 404），只能 `dsh plugin add github:…#v1.0.0`（tag 存在） | 1/2/4 窗真实会话并行、各窗保留草稿与阅读位置、用 DSH 原生对话组件；团队运行时（leader → 模块成员 → 子智能体、Host 调度器补位、派发授权、成果验收）。接口基线 **DSH 0.2.0-rc.2**；安装会把 profile 的 `subagent` 行改成 `maxDepth: 2` / `maxActiveSubagents: 40`，**影响同 profile 的其它任务** |
| [`omdsh-dev/DSH-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) | 是 | 4944 | 2026-11-05 | **有**：`dsh-better-sidebar@0.30.1`（npm 30+ 个版本，2026-11-05 更新） | 不是聚焦页，是**侧边栏底座**：`ctx.betterSidebar` 对第三方开 `registerTab` / `registerFileViewer` 两个扩展点（内置 6 个 tab、4 个 viewer 用同一 API）；内置文件树、编辑器、Git、子代理拓扑、底部终端工作台、侧边对话。要求 DSH 0.2.2-rc.1+ |

**核实不到 / 未核实的东西**（不编）：

- 四个仓库都**没有实际安装运行**过，仓库里的 `lib/client.js` 是否真如 README 所说、与本机 DSH 版本是否真兼容，没有实测。
- `dsh-topic-wall` 的 `package.json` 里没有 `engines.dsh`，README 只说「需要当前 DSH 客户端提供 `sessions` / `uiSession` / `uiWorkspace` / `modelDirectories`」——具体从哪个版本起可用，**未知**。
- 四个项目的 star 数都很低（除 better-sidebar），活跃度不能当作质量背书。

## 候选方案对比

| 方案 | 能拿到什么 | 成本 | 风险 |
|---|---|---|---|
| **A. 自研改造**（在 `focus.tsx` 上重做） | 用户标记（我这一轮在做哪几条）；按 `useSessionStatus` 分组的真实状态（等你审批 / 等你回答 / 已完成未读 / 在跑）；页内动作可先用已有的看板会话通道（`interrupt` / `pause` / `resume` / `end`） | 中：改 `protocol.ts` 的 `RunningSession` 或另立类型、接 `useSessionStatus`、加标记存储（`localStorage`，与 alert 无关）、补测试 | 需要动 `packages/console` 的 public 类型（`RunningSession` 对外导出），属跨插件契约变更；页内回复 / 审批要接 `uiSession`，**只有 Host 端不够** |
| **B. 参考 `dsh-session-focus`** | 已被验证的最小设计：标记三态 + 折叠后计数 + 状态分组面板；纯客户端、无 Host 路由，实现路径清楚 | 低：照抄它的数据模型（标记存本地、状态读 `useSessionStatus`），不引入包 | 只能「借鉴」，不能 `import`——插件之间无法互相 import 组件（`rules/plugin-ui.md`）；它的 DSH 下限 0.2.0-rc.2 高于本包 peer 下限 0.1.7-alpha.2，抄 API 时要兼容两条线 |
| **C. 直接引入 `dsh-topic-wall`** | 一步到位：置顶 / 进行中 / 集合卡片、卡内回复与停止、审批就地处理、每卡换模型、真实历史 | 低（装包），但**产品决策大**：它会成为工作台里第二套会话界面，与首页/看板的分工必须重划 | ① 未发布 npm，只能本地路径 / tarball 安装，用户侧升级链自建；② 主题是自绘三套（iOS / QQ空间 / 黑客），与 DSH 设计系统明确冲突；③ 依赖 `modelDirectories` 等服务，缺一则不可用；④ **与 `rules/plugin-ui.md` 冲突**：第三方 UI 自带样式与主题，不受本仓库规则约束 |
| **D. 直接引入 `dsh-team-workbench`** | 1/2/4 窗并行 + 智能体团队 | 低（装包） | ① `private: true`，只能 github tag 装；② 安装会改 profile 的 `subagent` 行（`maxDepth: 2` / `maxActiveSubagents: 40`），**污染同 profile 其它任务**；③ 基线 0.2.0-rc.2，本包仍要照顾 0.1.7 线；④ 与「聚焦」不是同一件事，它解决的是多窗与团队，不是「谁在等我」 |
| **E. 换底座到 `dsh-better-sidebar`** | 聚焦变成一个注册进侧边栏的 tab（`registerTab`），顺带拿到文件树 / Git / 终端 | 高：需要把 `dsh-better-sidebar` 装成**硬依赖**，本包的面板改成它的扩展；DSH 下限抬到 0.2.2-rc.1 | **与 `rules/plugin-ui.md` 直接冲突**：引入第三方 UI 依赖（且是底座级），`inject: ['betterSidebar']` 会让本包在没装它的部署里起不来；工作台首页仍是 `main` panel，两边会形成两套侧边栏语义 |

关于「引入第三方会与 `rules/plugin-ui.md` 的禁止新增 UI 依赖库冲突」这一条，需要说清它到底禁什么：规则原文是「**禁止新增 UI 依赖库、CSS 框架或 Tailwind**」，管的是**本仓库产物**引入的 UI 依赖。安装别人的插件不写进本包 `package.json`，技术上不算「本仓库新增依赖」；但只要本包**依赖它的服务或组件**（E 的 `inject: ['betterSidebar']`、或从 C 抄组件），就等于把不受本仓库规则约束的 UI 变成自己的地基——规则的精神被绕过。所以结论是：

- **C / D 可以「共存」**（用户自己装，本包不依赖），本包只需保证不与它们抢同一块地；
- **E 不能做**，它把第三方 UI 变成硬依赖；
- **B 只借鉴实现思路，不引入包**，不触发这条冲突。

## 推荐路线

**A + B：自研改造，按 `dsh-session-focus` 的最小模型设计，不引入任何第三方包。**

四条理由：

1. 真问题是「缺状态 + 缺动作」，不是「缺一个插件」——`useSessionStatus` 和看板会话通道都已在手边，不需要新依赖。
2. 界面必须留在 `main` 槽里（`CONSOLE_FOCUS_PANEL_ID`），与首页共用 `WorkbenchTop`；换成侧边栏 tab（E）会把「工作台」拆成两套外壳。
3. C 的能力值钱，但它的卡内回复 / 审批依赖 `uiSession` + 自绘三主题，应该**单独评估是否作为可选共存插件**，不该塞进聚焦页重做。
4. 聚焦页现在零测试，任何引入式方案都会让「坏了没人知道」这件事继续。

分步待办（按顺序，前一步不通过不进入下一步）：

- [ ] **T1 定性**：确认聚焦页的语义边界——只列「用户标记过 + 宿主状态非空闲」的会话，不列全部 running；未标记的收敛到侧边栏状态点，不在聚焦页重复。
- [ ] **T2 类型**：给聚焦页单独的视图类型（不要直接扩 `RunningSession`，它是 `protocol.ts` 对外导出的契约）；字段至少 `sessionId` / `title` / `cwd` / `status`（running / waiting-approval / waiting-input / completion-unread）/ `lastActivityAt`。
- [ ] **T3 状态接线**：浏览器半边从槽的 `useSessionStatus` 读真实状态（`GlobalStandardProps`，不用新增依赖）；Host 侧只补「用户标记」与「最后活动时间」两件页面拿不到的事实。
- [ ] **T4 标记**：三态标记（无 / 进行中 / 挂起），存 `localStorage`，跨标签用 `BroadcastChannel` 同步——参考 `dsh-session-focus` 的实现形状，不抄代码。
- [ ] **T5 页内动作**：先接已有的看板会话通道（`interrupt` / `pause` / `resume` / `end`），失败原因就地显示；卡内回复 / 审批留作 T6，需要 `uiSession` 才能做。
- [ ] **T6 卡内回复与审批**（可选）：评估接 `uiSession` 的 `session/prompt`、`session/cancel` 与审批 surface，前提是宿主提供该服务；不提供就保留「进入会话」。
- [ ] **T7 `openSession` 降级说明**：`uiWorkspace` 缺失时，页面要说「本部署未装工作区页，只能复制会话 id」，而不是把按钮静默拿掉（`focus.tsx:64`）。
- [ ] **T8 测试**：`FocusPage` 至少覆盖「等你审批的会话必须出现」「无标题会话显示短 id」「标记切换持久化」「动作失败就地显示原因」四条。

## 本次不做（作用域边界）

- **不改 `packages/**` 任何文件**，不重构 `focus.tsx` / `shell.tsx` / `protocol.ts`。
- **不安装、不引入**任何一个调研的插件；不把它们写进任何 `package.json`。
- **不改** `CONSOLE_FOCUS_PANEL_ID`、`RunningSession`、`ConsoleView` 等对外契约。
- **不改** `rules/`、`AGENTS.md` 的索引（本文若要长期保留，另开一次改动把它登记进文档索引）。
- **不做**实测验收（本轮没有启动 DSH 实例验证聚焦页行为）。
