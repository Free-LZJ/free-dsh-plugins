# Git 与发布

**何时加载**：执行任何 Git 写操作（`add`、`commit`、`rebase`、`push`、改提交历史）之前；执行 `npm publish` 或改版本号之前。只读检查（`status`、`diff`、`log`、`show`、`blame`）无需加载。

## 授权

- **可以自动提交**：一个独立功能完成后（自测通过、工作区里这批改动自成一体），agent 可自行 `add` + `commit`，不必先问。用户要求"先别提交 / 攒着一起提"或当前任务明确只是探索、试验时除外。
- **按功能切分提交**：一次提交只装一个可独立描述、可独立回滚的功能或修复。一个任务里做了两件互不相关的事就分两次提交；同一功能的代码、测试、规则、文档改动放同一次提交，不拆成"代码一次、文档一次"。
- **提交里不含半成品**：功能未完成、测试未通过、留有待联调占位时不提交；把未完成部分留在工作区，先提交已完整的那一块。
- 用户要求提交 ≠ 允许推送。没明确要求推送就不 `push`；自动提交也只停在本地。
- 提交前先 `git status --short`，只暂存本次功能涉及的路径并显式写出；禁止 `git add -A` / `git add .`，禁止夹带工作区里他人未提交的改动（例如别人正在改的包、未跟踪的临时文件）。
- 提交后报告提交哈希与消息，便于用户回退或调整。
- 拉取用 `git pull --rebase`，分支整合用 `git rebase`，不产生 merge commit。遇到冲突只处理本次任务相关内容。

## 提交消息

沿用仓库现有 Conventional Commits 单行格式：

```text
<type>(<scope>): <简述>
```

- `type` 取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test`；`scope` 用包名（`agent-import`、`mail`、`web-search-account`）或 `repo`、`docs`、`rules`。
- 影响单个包且值得用户感知的改动，正文用 `- ` 列表补充关键变更；纯规则、纯格式类改动写单行即可。
- 发版提交用 `chore(release): <包名> <版本> — <说明>`，一个包一次提交。

## 版本与发布

- 版本号只改 `packages/<包名>/package.json`；npm 上已发布的版本不可重发，也不得回退。
- 破坏性变更：改 Loader 行 id、改 `exports` 路径、删配置字段，必须升 minor 以上，并在包 README 的"升级"小节写清迁移步骤（仓库已有 0.2.x → 0.3.0 的合包迁移先例，照着写）。
- 发布在包目录执行 `npm publish`，`prepublishOnly` 会先 build。
- **发布后改 README 不会同步到 npm**：npm 包页的 README 取自 tarball，需要重发一个版本才会更新。
- 根 `README.md`、`README.en.md` 包表里的版本号必须与各包 `package.json` 一致，发布提交里一起改。

## 禁止

- 不提交 `lib/`、`node_modules/`、`.tarballs/`、`.dsh-work/`、`.playwright-cli/`（已在 `.gitignore`）。
- 不把调研输出、截图、一次性脚本落进仓库；先放 `.dsh-work/`。
