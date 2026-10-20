# 插件界面：跟随 DSH 设计系统

**何时加载**：改任何插件的浏览器半边界面（`src/client/**` 的组件、样式、文案）时；排查 DSH 自身的渲染或布局行为时。

插件的浏览器半边运行在 DSH 的页面里，**必须使用 DSH 的设计系统**，不得自成一派。权威规范是 DSH 仓库的 `docs/web-styling.zh.md` 与 `docs/ui-radius.zh.md`（本机源码在 `D:\open\deepseek-harness`），那两份说了算；本规则只列本仓库可机械检查的那几条，冲突时以 DSH 为准。

## 查 DSH 行为：读本机源码，不要解包

要弄清 DSH 自己怎么算高度、怎么排布、主题 token 从哪来，直接读上面那份本机源码仓库，**不要**去反解已安装的 `app.asar`：两者是同一份代码，但源码带原始类名、完整选择器和解释性注释，解包出来的 `lib/client.js` 只剩 `BynINW_frame` 这类哈希类名，读得慢还容易读错。只有源码不在本机的部署机才退回解包。

主面板高度就是个例子：`packages/client/ui-layout/src/client/AppFrame.module.css` 的 `.frame` 是 `height:100%`，Windows 下再叠加 `padding-top: var(--dsh-windows-titlebar-height)`，`.centerCol` 是 `overflow:hidden`。所以主面板槽位始终比 `100vh` **矮一个标题栏**——插件面板外壳写 `min-height:100vh` 就会比槽位高，超出部分被裁掉，而面板自己以为完整。

## 控件：先查目录再写

- 写控件前先查 `packages/client/ui-primitives/README.zh.md#组件目录`（DSH 仓库）。插件之间无法互相 import 组件，该包是控件唯一能共享的地方。
- 按钮、输入、分段、开关、复选框、下拉菜单、浮层、徽章一律复用：`Button`、`Input`、`SegmentedControl`、`Switch`、`Checkbox`、`Menu`／`MenuItemButton`／`MenuSurface`、`Tag`、`Pill`、`Tooltip`、`Modal`。有意的视觉差异提升成 `ui-primitives` 的 prop，不在本仓库另起一份拷贝。
- 禁止新增 UI 依赖库、CSS 框架或 Tailwind。

## 颜色与材质

- 只用 `--dsw-alias-*` 语义 token：`--dsw-alias-label-primary|secondary|tertiary`、`--dsw-alias-border-l1..l4`、`--dsw-alias-bg-layer-1..3`、`--dsw-alias-bg-overlay`、`--dsw-alias-interactive-bg-hover|active`。
- 不得出现颜色字面量（`#fff`、`rgba(...)`）。
- 不得复制静态色板值：`--dsw-static-*` 只允许在主题包；唯一例外是 DSH 文档里写明的那几处。

## 圆角：只用 token，按用途选档

| 用途 | token |
|---|---|
| 紧凑控件、小按钮 | `--dsw-radius-sm`（R8） |
| 按钮、单行 cell、输入框 | `--dsw-radius-md`（R12） |
| 多行 cell | `--dsw-radius-lg`（R16） |
| 独立内容卡片 | `--dsw-radius-xl`（R20），材质 `--dsw-alias-settings-card-fill` + `--dsw-alias-settings-card-stroke` |
| 面板、对话框 | `--dsw-radius-panel`（R28） |

禁止 10px、14px、18px、24px 这类局部数值。

## 描边与分割线

- 中性 `--dsw-alias-border-*` 一律 `0.5px`。
- `1px` 只留给 dashed 记号与状态色边框。

## 浮层

- 菜单、浮层、对话框、面板、浮起按钮、输入框设 `border: 0`，用 `--dsw-elevation-panel|prominent|soft`（已含 0.5px 发丝描边）。
- 不得把 `--dsw-alias-border-*` 的 border 与层级阴影配对。
- 下拉菜单用 `Menu`／`MenuSurface`，不得自己写浮层材质或覆盖 `--dsw-menu-surface-fill`。

## 排版、焦点与动效

- 字号必须与行高成对出现（例如 14/22、13/20、12/18），不得只写 `font-size`。
- 可交互元素保留 `--dsw-focus-ring-width` 的键盘焦点环（`outline-offset` 按组件选 2px 或 -2px）。
- 仅悬停可见的控件必须在键盘聚焦时同样可见；保留 `prefers-reduced-motion` 行为。

## 图标与作用域

- 用 `ui-primitives` 的图标集（`Icon*Regular`／`Icon*Medium`），不得用 emoji 或自绘字形充当产品图标。
- 插件的样式只作用于自己的类名前缀（如 `dshc-`），不得改全局选择器或主题变量。

## 验收

改完界面要在**浅色与深色两种主题**下看实际渲染，至少覆盖默认、hover、键盘焦点三种状态。

## 检查

在仓库根用 PowerShell 执行；标了「应无输出」的几条有输出就是违规（最后两条人工复核）：

```powershell
# 查 DSH 行为时读源码而不是解包：本机源码仓库仍在该路径 —— 应输出 True
Test-Path D:\open\deepseek-harness\packages\client\ui-layout\src\client\AppFrame.module.css

$src = Get-ChildItem -Path packages/*/src/client | Get-ChildItem -File -Recurse

# 颜色字面量 —— 应无输出
$src | Select-String -Pattern '#[0-9a-fA-F]{3,8}\b|rgba?\('
# 静态色板值 —— 应无输出
$src | Select-String -Pattern '--dsw-static-'
# 中性实线边框写宽了（0.5px 才是发丝线）—— 应无输出
$src | Select-String -Pattern 'border[a-z-]*:[^;]*1px'
# 圆角写了局部数值 —— 应无输出
$src | Select-String -Pattern 'border-radius:[^;]*[0-9]+px'
# 手写控件：这些 role 由 ui-primitives 拥有 —— 应无输出
$src | Select-String -Pattern 'role="(tablist|switch|checkbox|menuitem|menu)"'
# 面板外壳拿视口高度当槽位高度（会被标题栏裁掉）—— 应无输出
$src | Select-String -Pattern "minHeight:\s*['""]100vh['""]"
# emoji / 符号字形当图标 —— 应无输出
$src | Select-String -Pattern '[\uD83C-\uDBFF\u2600-\u27BF]'
# 每个 font-size 附近是否配了 line-height
$src | Select-String -Pattern 'font-size'
# 控件是否从共享原语 import
$src | Select-String -Pattern "from '@deepseek-ai/dsh-client-ui-primitives'"
```

