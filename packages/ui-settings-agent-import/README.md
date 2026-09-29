# @free-lzj/dsh-client-ui-settings-agent-import

[`@free-lzj/dsh-agent-import`](../agent-import/README.md) 的浏览器伴生包：在 dsh Web 插件页的**官方**分组里注册一张「代理配置导入」卡片，用来读取并保存那个 Host 插件的配置。

Host 半边本身不渲染任何界面；这个包也不做任何导入工作，只是那张卡片。

## 它跟随什么

卡片的注册条件是 **Host 正在服务 `agent-import` 设置命名空间**：

- 命名空间就是 Host 那条 Loader 行的条目 id，所以那行必须叫 `agent-import`；换个 id 就是另一个命名空间，这张卡片永远不出现。
- Host 行缺失或被停用时，卡片直接消失（不是显示"未加载"），页面上不留痕迹。
- 保存写入 Host 的设置表单；本部署不支持持久化时页面显示只读提示。

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'

    - id: ui-settings-agent-import
      name: '@free-lzj/dsh-client-ui-settings-agent-import'
```

安装与完整步骤见[仓库根 README](../../README.md)。

## 卡片内容

- **来源**：Codex / Claude Code 两个开关（`sources`）；
- **开关**：导入 MCP 服务器、导入技能、包含 Codex 自带技能、服务器启动失败即报错；
- **跳过的服务器**：`serverDenyList` 一行一个，可增删；
- **数值**：`maxServers`、`maxSkills`，只接受 0 或更大的整数，留空表示使用默认值；
- **路径**：`projectRoot`、Codex 主目录与配置文件、Claude Code 目录与配置文件，留空即沿用文档中的回退（`$CODEX_HOME`、`~/.claude` 等）；
- 用户层显式设过的字段标 **已覆盖** 并提供 **恢复默认**；只有 **保存** 会写入，且一次性写全部暂存修改，离开页面丢弃草稿。

## 构建

浏览器半边由 `tsdown` 打成浏览器 CJS 包 `lib/client.js`，其中 dsh Web 外壳共享的模块（React、`@deepseek-ai/cordis`、`client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`）保持外置、其余内联；`lib/index.js` 是空的 Node 半边，只为让这个包占住一条 Loader 行。

```sh
pnpm run typecheck
pnpm run build
pnpm run test      # 在本仓库根目录运行 vitest
```

### 测试如何拿到 dsh 的客户端代码

5 个浏览器半边 spec 只依赖 npm 上发布的包，但有两处需要说明：

- **平台包只有 Node 半边。** `dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-slots` 在 npm 上不发布浏览器包（浏览器版本由 Web 外壳自己打进 bundle），其 Node 半边的依赖保持外置。所以本包把这些外部依赖（`clsx`、`zustand`、`immer`、`shiki`、`katex`、`micromark` 系列等）显式声明为 `devDependencies`，并让 `vitest.config.ts` 的 `server.deps.inline` 把它们交给 Vite 转换——CSS 模块也走这条路径。
- **浏览器半边按模块表加载。** `dsh-client-locale`、`dsh-client-ui-renderer`、`dsh-client-ui-settings` 发布的 `lib/client.js` 是给 Web 外壳的模块表用的：它调用 `window.__ModuleLoader__.load({ id, factory })`，通过外壳给的 `require` 取平台模块。`tests/support/module-loader.ts`（经 `setupFiles` 装载）在 jsdom 里装一张最小模块表，spec 再用 `clientModule(id)` 取它的导出。
- `tests/support/runtime.ts` 是 dsh 仓库里 `@deepseek-ai/dsh-client-test-runtime` 的本地替身：那个包发布时保留了只在 dsh 仓库内存在的源码路径，无法从 npm 使用。

## 已知限制

- 不在 dsh 自带 Web 组合里：必须自行安装并声明上面前面那两行。
- 只在 Host 服务该命名空间期间存在；Host 行停用即撤销。
- 不展示导入结果清单（需要 dsh 自身的 Remote 命名空间）。
