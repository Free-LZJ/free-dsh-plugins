# @free-lzj/dsh-console

**DSH 的工作台：插件有了统一的首页，通知有了统一的出口。**

装好后侧边栏第一个图标就是它。首页是**已接入工作台的插件列表**（默认卡片宫格，可切列表 / 紧凑网格，支持搜索与置顶）；点卡片在主区域打开那个插件的面板。同时它是**平台内核**：面板怎么接进来、通知怎么发出去，都由它事先定好的接口说了算。首页上方还有一块**任务看板**：进来的工作事件先分类、再路由，最后落成卡片，派单后在会话聚焦视图里跟进。

首页只有接入过的插件——没接入的第三方插件不会出现在列表里，工作台不枚举 profile 里装了什么。所以「工作台里有什么」完全由各插件自己声明，不由 dsh 加载了什么决定。

## 三块能力

### 1. 面板接入契约

插件不再自己抢侧边栏，而是声明「我是工作台的一个面板」：

```ts
import { useConsolePanel } from '@free-lzj/dsh-console/contract'

export function apply(ctx: ClientContext): void {
  useConsolePanel(ctx, {
    id: 'mail',                       // main 槽的键，工作台按它打开面板
    title: () => t('panel'),
    description: () => t('description'),
    keywords: () => ['mail', 'imap'],
    order: 20,
    render: MailPanel,                // 面板本体；布局照常给它 main 的两个席位
    icon: <MailIcon />,
  }, {
    locale: NS,                       // 没有工作台时，退回自己的侧边栏入口
    order: 40,
    label: () => t('panel'),
    Icon: MailIcon,
  })
}
```

两种模式由**运行时**决定，不是编译期开关：

| 模式 | 什么时候 | 结果 |
|---|---|---|
| **接入** | 组合里有工作台 | 插件交出侧边栏那一格，只在工作台首页出现；面板本身（`main:<id>`）**保留**，工作台按这个键打开它 |
| **独立** | 没有工作台 / 工作台被禁用 | 插件保留自己的侧边栏图标与面板，行为和装工作台之前完全一样 |

判断不是「启动时看一次」：Loader 行的顺序由用户的 profile 决定，工作台可能**晚于**插件挂载；工作台被禁用时插件也要把侧边栏还回来。所以契约用 `ctx.inject` 跟随服务出现/消失，这条路径有专门的测试。

契约产物（`@free-lzj/dsh-console/contract`）是**普通模块**：消费方打包时把它内联进去，所以插件不需要工作台在页面的 module table 里，也**不产生运行时依赖**——没装工作台照样能装上。

### 2. 通知接口 + 可替换渠道

任何插件（Host 半边）都能把一条通知交给工作台统一处理：

```ts
await ctx.console?.notify({
  title: '新邮件',
  body: '来自张三：季度评审改到周四',
  tone: 'info',
  source: 'mail',
})
```

工作台决定「怎么告诉用户」：渠道是一组**策略**，注册在内核里、由配置多选启用。

### 3. 任务看板

看板是首页上半部分：**待办 / Agent 处理中 / 已处理**三列，卡片带来源、优先级、分类置信度、执行器与实时状态；卡片点开进会话聚焦视图，可以看实时日志、插话、暂停 / 继续 / 结束。页面下方还有事件模拟器（投递一个事件，看它怎么分类、路由、建卡）和连接器清单。

流转是「确定性外壳 + 判断核 + 路由表」三层，和通知渠道一样的策略 + 注册表写法：

| 层 | 是什么 | v0 的实现 |
|---|---|---|
| 分类核 | 判断事件是什么任务 | 规则分类器（关键词打分，附置信度与理由）；大模型分类器是以后实现同一接口的另一个实现 |
| 路由表 | 判断之后怎么办 | `$DSH_HOME/dsh-console/routing.json`，改完自动热加载，不用重启 |
| 执行器 | 派给谁干活 | `dsh` / `codex` 两个 id，目前都是**模拟执行器**：跑固定脚本、写日志，不调模型、不碰工作区、不写任何外部系统 |
| 连接器 | 事件从哪来、结果往哪去 | `mail` / `webhook` 有入口（ingest 路由），`dingtalk` / `jira` 是占位：列出来、可配置，但不发真实请求 |

规则只有三条硬线：置信度低于 0.6 的卡一律不自动派，落进待办等人工；同一来源同一外部 id 重复投递不重复建卡；**完工的卡只进「已处理」并标「待确认回写」，不自动回写任何外部系统**。审 diff 关口是用户明确暂缓的，v0 没有。

事件入口有两条：页面上的事件模拟器，和 Host 上的 `ctx.console.ingestWorkbenchEvent(event)`（邮件这类插件以后从这里转交；调用前先探有没有这个方法，没有就是没挂看板）。

| 渠道 | 行为 |
|---|---|
| `desktop` | 走浏览器 Web Notification，在 Windows 通知中心弹出（需要授权） |
| `inapp` | 工作台通知中心：铃铛角标 + 列表 |
| `sound` | 一声短提示音 |

- 前两个渠道**只在有页面打开时**才计划投递（`plan()` 会回答否），因此不会「通知丢掉还不知道」。需要一个「没开页面也能送达」的渠道时，注册一个新的实现即可——见下面「加一个渠道」。
- 一条通知可以同时走多个渠道；某个渠道失败只影响它自己，`notify()` 不 reject，通知照常进中心。
- 至少保留一个渠道：设置行的最后一个开关是锁住的。
- 配置里出现本版本不认识的渠道 id（升级删了实现）会被丢弃并告警，不会让配置整个失效。

## 安装

```sh
# Web
dsh plugin --profile web add @free-lzj/dsh-console

# 桌面端
dsh plugin --profile desktop add @free-lzj/dsh-console
```

本包自带 `dsh.bundle`，`dsh plugin add` 已经插入 `console` 这一行，所以 profile 补丁里**不用也不要**再手写同 id 的 `- insert:`（同一个 id 两行 → 插件市场预检报 `duplicate loader entry id` 并回滚安装）；要覆盖配置就写一行同 id 的 override（`- id: console` + `config:`，**不带** `insert`）。

<details>
<summary>从本仓库安装（改本包时才需要）</summary>

```sh
pnpm install
pnpm --filter @free-lzj/dsh-console run build

dsh plugin --profile desktop add "<本仓库绝对路径>/packages/console"
```

</details>

装完**重启一次 dsh**（Host 半边是启动时加载的 JS）。改浏览器半边刷新页面即可。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `channels` | `('desktop' \| 'inapp' \| 'sound')[]` | 全部三个 | 通知走哪些渠道。设置 → 通用 → **通知** 里多选，写回这一行 |
| `layout` | `'grid' \| 'list' \| 'compact'` | `grid` | 首页布局。首页右上角切换，写回这一行 |
| `workbenchConnectors` | `('mail' \| 'webhook' \| 'dingtalk' \| 'jira')[]` | `['mail', 'webhook']` | 看板启用哪些连接器；写了实现里没有的 id 会被丢弃并告警 |
| `workbenchClassifier` | `string` | `'rule'` | 看板用哪个分类器；写了没注册的 id 会回落到规则分类器并告警 |

页面的置顶（`$DSH_HOME/dsh-console/prefs.json`）不在这一行里：它是**用户点击产生**的状态，不是配置。

## 工作台里的界面

界面跑在 DSH 的页面里，所以完全用 DSH 的设计系统（`ui-primitives` 控件 + `--dsw-*` token），不另起一套；约束见 [`rules/plugin-ui.md`](https://github.com/Free-LZJ/free-dsh-plugins/blob/main/rules/plugin-ui.md)。

- **页头**：对齐对话页顶栏——底部 0.5px 发丝线（`--dsw-alias-border-l3`），左侧页面标题 16/24、字重 500；右侧工具栏靠右：带共享搜索图标的搜索 `Input`、切换三种布局的 `SegmentedControl`、通知按钮。
- **首页**：已接入的插件卡片。卡片用 DSH 的设置卡片材质（R20 + `--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke`），标题 14/20 字重 500、说明 12/18 tertiary；卡片末尾的「⋯」`Menu` 里是**置顶 / 取消置顶**。
- **通知中心**：通知按钮上的角标 + 下拉列表，可清空。
- **设置 → 通用 → 通知**：渠道从多选下拉里选（`Menu` 的 `selectedIds`）。设置行用 DSH 的设置行几何——标题 14/22、说明 12/18 tertiary、`padding: 16px 0`、`border-bottom: 0.5px solid var(--dsw-alias-border-l2)`。

## 谁的数据在哪一半

列表不是 Host 下发的：面板的标题、说明、顺序、图标都由**接入插件自己的浏览器半边**声明，只有那一侧能渲染它们；Host 只保存置顶 id 列表和通知、渠道、布局。浏览器把两边拼成卡片，所以「工作台显示哪些插件」这件事没有第二份真相。

## 给插件作者：三个扩展点

| 想做的事 | 用什么 |
|---|---|
| 把面板接进工作台 | 浏览器半边 import `@free-lzj/dsh-console/contract` 的 `useConsolePanel` |
| 发一条通知 | Host 半边 `ctx.console.notify({...})`（可选依赖，用 `?.`） |
| 加一个通知渠道 | 在本包里 `ctx.console.channels.register({ id, plan, deliver })`，再在设置行加一个名字 |

前两个是给外部插件的稳定接口；第三个目前是包内扩展点（渠道实现在 `src/builtin-channels.ts`，注册在 `src/index.ts`）。加渠道**不需要**改通知派发逻辑——派发只认识接口。

## 数据边界

- **路由**：`/dsh-console/state`（读快照）、`/dsh-console/events`（SSE：状态与通知）、`/dsh-console/config`（写配置）。读路由只回答同源请求；写路由额外要求 `x-dsh-console: 1` 与 JSON content-type——跨站表单发不出这个自定义头。看板另有三条：`/dsh-console/workbench/state`（读看板）、`/dsh-console/workbench/ingest`（投递事件）、`/dsh-console/workbench/action`（派单 / 移卡 / 插话 / 暂停 / 继续 / 结束），同一套守卫；其中 ingest 目前只接受同源请求，外部 webhook 接入要先补签名校验。
- **状态**：`$DSH_HOME/dsh-console/prefs.json`（置顶），权限 `0600`，写盘走临时文件 + `rename`；读到坏 JSON 回落为空而不是让插件起不来。看板另有 `$DSH_HOME/dsh-console/workbench.json`（卡片与会话，同一写法）和 `routing.json`（路由表，缺失时写入默认表，改坏时沿用上一版并告警）。
- **通知**：只存在内存里（本次运行，最多 50 条），重启即清空；不落盘、不外发。
- **卡片审计**：每张卡存着路由决策（动作、执行器、路由 id、路由表版本、分类与理由），路由改了可以拿同一批事件重放对照。

## 已知限制

- **看板执行器是模拟的**：`dsh` / `codex` 目前只跑固定脚本、不调模型、不改代码；接真实 agent 是以后实现同一执行器接口的事，不是改看板。
- **看板不自动回写**：完工的卡只标「待确认回写」，钉钉 / Jira / 邮箱的出站动作都没有接；确认后回写的流程等用户定。
- **看板没有审 diff**：用户明确暂缓，v0 的「已处理」只表示 run 跑完了，不表示 diff 被审过。
- **钉钉与 Jira 是占位**：看板里列得出、配得上，但不发真实请求；它们的事件目前只能经 ingest 路由以对应来源投递演示。
- **接管只到侧边栏那一格**：侧边栏面板列表是平台的一个列表槽，没有按 id 过滤的入口。所以接入工作台的插件交出的只是**侧边栏那一格**；它在 `main` 上的面板仍然存在（正是工作台打开它的方式）。别的插件若在别处放了自己的入口，工作台管不到。
- **列表里只有接入过的插件**：这是刻意的——工作台不枚举 profile，也就不会列出、更不会「内嵌」没接入的插件。它们照旧从自己的侧边栏入口进入。
- **通知没有历史**：不落盘，也没有「已读」状态；清空就是清空。
- **桌面通知需要授权**：浏览器拒绝后 `desktop` 渠道投递失败（仅影响它自己），设置行会说明原因。授权只能由用户在浏览器里给。
- **`plan()` 需要页面在场**：`desktop` / `inapp` / `sound` 都要求至少一个工作台页面在流式接收事件；没有页面时投递为空（通知仍进内存）。这是「页面才能弹通知」的物理限制，不是遗漏。
- **契约是内联的**：改契约（`src/client/contract.ts`）之后，消费方要**重新构建**才拿到新版；契约的产物形状有测试兜底，但版本对齐靠各自发版。

## 开发

```sh
pnpm --filter @free-lzj/dsh-console run typecheck
pnpm --filter @free-lzj/dsh-console run build

# vitest 的 include 是仓库根相对路径，测试要从仓库根跑
pnpm exec vitest run packages/console
```

测试不连网、不弹真通知：渠道用注入的 `PageSurfaces` 假实现，页面事件流用真的 SSE 编解码但由测试驱动 `EventSource`，契约的两种模式跑在真的 cordis Context + 真的插槽注册表上（注册表取自渲染器浏览器半边，不是替身）。

## License

[MIT](LICENSE)
