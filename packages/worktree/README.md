# @free-lzj/dsh-worktree

在**新开一个会话**时决定它要不要跑在一个全新的 Git 工作树里：点一下首屏的「新建工作树会话」，填个名字，dsh 就从当前仓库的最新提交建一个独立检出，并在这个检出里打开新会话。原检出、原工作区、原分支都不动。

## 安装

```bash
dsh plugin --profile web add @free-lzj/dsh-worktree
```

装完重开 dsh。插件插入一行 Loader 行 `worktrees`。

## 用法

1. 新建会话（或打开一个还没有第一条提示的空白会话），首屏那一行出现**新建工作树会话**。
2. 点它：对话框里填名字（留空自动生成 `worktree-xxxxxxxx`），确认。
3. dsh 建好检出、把它注册成一个工作区、在那个工作区里打开空白会话，光标就在输入框里。

之后它和普通工作区没有区别：会话、历史、审批、后台任务都在那个检出里跑。

### 检出放在哪

```text
<仓库根>/.agents/worktrees/<名字>      检出目录，分支同名
<仓库根>/.agents/worktrees/.gitignore  内容 `*`，只在本次创建了该父目录时写
```

这和官方实验 bundle `@deepseek-ai/dsh-experimental-worktree` 的布局**完全一致**，所以两个插件可以同时装、互不打架（Loader 行 id 分别是 `worktrees` 与 `worktree`）。想让它显示成仓库下的子工作区：侧边栏 `视图选项 → 分组方式 → 按工作区树`。

## 行为与约定

| 事项 | 现在的行为 |
|---|---|
| 起点 | 当前会话所在工作区的仓库 `HEAD`（`git rev-parse --show-toplevel` 找仓库根） |
| 名字 | 允许字母、数字、点、下划线、短横线，最长 64；同名分支或目录已存在时报错，不覆盖 |
| 复制内容 | **只复制已提交内容**。暂存、未暂存、未跟踪、被忽略的文件都不带过去 |
| 失败 | 返回 Git 的第一行错误，原检出不受影响；已建好一半的目录会留下 |
| 权限 | 沿用 Host 进程自己的文件权限；不额外申请沙箱权限 |

## 已知限制

- **只管创建**：不列已有工作树、不删除、不合并、不删分支。收拾旧的检出仍然靠 `git worktree remove`。
- **不 fetch**：只在本地对象上工作；仓库缺对象时会直接失败。
- **不装依赖**：新检出是干净树，需要 `pnpm install` 之类由你或 agent 在会话里做。
- **一个会话一个目录**：创建后不会把当前会话搬过去，而是**新开**一个会话；正在进行的会话留在原处。

## 开发备注

**为什么 `tsconfig.json` 里有 `paths`**：本包开发依赖钉在 0.2.x 预发布，而仓库其他包仍构建在 0.1.x，pnpm 因此会链接两份 `@deepseek-ai/cordis` / `dsh-client-ui-slots`。模块增强（`ctx.slots`、`ctx.locale`、`SlotMap`、`LocaleNamespaceMap`）只并入**同一份物理模块**，指错副本的症状是 `Property 'slots' does not exist on type 'Context'`。`paths` 把两侧都指向本包自己那一份，即本包 peer 实际运行的那一版。等仓库整体升到 0.2.x 后可以删掉。

**为什么 Git 走 `node:child_process`**：本包不依赖 harness 的 `subprocess` 服务，少一层装配；参数全部是本模块拼的字面量，没有 shell 插值。需要更严格的进程策略时再接 `subprocess`。
