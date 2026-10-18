# 仓库约定

pnpm monorepo：`packages/*` 每个目录一个 dsh 双面包（Host 半边 + 浏览器半边）。

## 临时文件不进 git

- 一次性脚本、抓取脚本、调研输出、日志、截图、导出数据一律写进 `/.dsh-work/`（已 gitignore）或系统临时目录，不要落在仓库根或 `packages/` 里。
- 不要用 `git add -A` / `git add .`，只加明确写出的路径。
- 提交前先 `git status --short` 过一遍，确认没有未跟踪的临时文件被带进 commit。
