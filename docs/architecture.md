# 架构：双面包为什么这样切

> 本文是背景与原理，不是约束。约束见 `rules/packages.md`、`rules/build.md`。

## 一个包，两半

dsh 的插件从一条 **Loader 行** 挂载。行里写的是包名，Loader 让 Node 进程 `import()` 该包的 Host 半边；如果包的 manifest 里有 `dsh.client`，dsh Web 会把该包的浏览器半边作为 module-table 闭包工厂加载进页面，并挂在同一条行上。

```
profile 补丁
└── - id: mail            ← 行 id：设置命名空间 / 路由前缀 / 面板 id 都取自它
      name: '@free-lzj/dsh-mail'
          │
          ├── Host 半边   lib/index.js   → Node：长连接、HTTP 路由、设置项
          └── 浏览器半边  lib/client.js  → 页面：侧边栏面板、设置页
```

两半**不同步通信**：浏览器半边拿数据只能走 Host 暴露的路由或设置命名空间。因此"面板里显示的东西"与"Node 里拿到的东西"之间没有隐式共享内存，所有桥接都必须显式。

## 为什么必须是一条行

0.2.x 时代 `agent-import` 拆成两个包（Host 包 + `dsh-client-ui-settings-agent-import`）各占一条行，结果是：

- 装一个功能要装两个包、两条行，卸载时容易只卸一半；
- 两个行的启动顺序要靠依赖声明保证，否则设置页先于 Host 半边挂载而拿不到命名空间。

0.3.0 合包后由 `dsh.client` 声明让浏览器半边自动挂上同一条行，这个问题从结构上消失。**不要再拆回去。**

## 为什么 id 不能随便改

行 id 被复用为三样东西：设置的命名空间、Host 路由前缀、浏览器面板 id。改名以后既有用户 profile 里那一行依旧存在、配置却挂到了不存在的位置，表现出来就是"插件装了但配置全丢"。所以改名按破坏性变更处理。

## 为什么由包自带 `dsh.bundle`

`dsh plugin add` 只让包可解析，不产生 Loader 行。把 `cordis.patch.yml` 声明在 `package.json` 的 `dsh.bundle.patch` 里，安装时自动插入那唯一一行，用户的 profile 补丁里只要写同 id 的 override 传配置即可。手写同 id 的 `- insert:` 会造成两行同 id，插件市场预检直接回滚安装。

## 构建为什么是 tsc → tsdown 两段

`tsc` 一段负责三件事：产出 `.d.ts`、把本地 import 的 `.ts` 后缀改写成 `.js`（Node 消费者可直接解析）、把语法降到目标版本。`tsdown` 再以 `lib/types` 为输入分别打两个形态：

- Node 半边保持 ESM、platform=node、依赖与 peer 全部 external —— 运行时用 dsh 自己的实例，而不是打包进第二份。
- 浏览器半边打成 CJS 闭包工厂，banner/footer 把它包成 `window.__ModuleLoader__.load({ id, factory })`，`require` 参数由页面的 module table 提供。平台模块必须 external，否则页面里会出现第二份 React。

## 协作者

- 真实组合的端到端测试（装一次 dsh、断言工具与技能可见）留在 dsh 主仓库跑，因为它依赖主仓库的 profile 启动夹具；本仓库 CI 只跑类型检查、构建、单测与组件测试。
- 浏览器半边的测试需要 dsh 客户端包的 Node 半边与 module table，接线在 `vitest.config.ts` 与 `packages/agent-import/tests/support/module-loader.ts`。
