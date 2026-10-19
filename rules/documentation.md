# 文档维护规范

**何时加载**：新建或修改 `README.md`、`README.en.md`、`packages/*/README.md`、`docs/**`、`examples/**` 中的说明文字时。

核心约束：**README 是门面，不是仓库。** 任何一段只对"正在改这个仓库的人"有用的信息，都不属于 README。

## 归位

| 信息 | 位置 | 不属于这里 |
|---|---|---|
| 仓库是什么、包清单与一句话介绍、安装命令、发版状态 | 根 `README.md` / `README.en.md` | 实现细节、踩坑、内部约定、排障步骤 |
| 单个包的安装、配置字段、能力与已知限制 | `packages/<包名>/README.md` | 仓库级约定（放根 README 或 `rules/`） |
| dsh 插件机制背景、双面包原理、构建与测试接线、排障 | `docs/**`（见下表） | README |
| 约束（做 / 不做） | `rules/**` | 任何 README、任何 `docs/` |
| 目录边界与索引 | `AGENTS.md` | 任何 `docs/` |

`docs/` 目录约定：

| 文件 | 内容 |
|---|---|
| `docs/architecture.md` | 双面包为何这样切、Host/浏览器两半的边界、Loader 行与 `dsh.bundle` 的关系 |
| `docs/development.md` | 本仓库的构建、测试、本地联调、发布的展开说明 |
| `docs/troubleshooting.md` | 已知故障现象与排查路径（`duplicate loader entry id`、兼容性预检整行禁用、产物契约测试 skipped 等） |

## 写作要求

- 新增一节前先判断上表中的落点；README 加内容前先自问"删掉包之后这句还有用吗"。
- 根 README 每增长一块，就检查是否应拆到上表位置；总长度超过"一块屏能扫完 + 安装"时，必须拆。
- 中英文 README 结构一一对应：改一方必须同步另一方，不允许只改其一。
- 文档描述必须与当前代码一致；能力尚未实现或未验证的不写进 README，写进 `docs/` 并标注状态。
- 不新增图片、截图、导出文件到仓库根目录；调研产物、一次性脚本一律进 `.dsh-work/`（已 gitignore）。

## 验收

- 文档改动后检查所有相对链接可解析（尤其是 `packages/*/README.md` 里指向根 README 的链接是 npm 上的绝对地址，不要改成相对路径）。
- `README.md` 与 `README.en.md` 的包版本号、安装命令必须一致。
