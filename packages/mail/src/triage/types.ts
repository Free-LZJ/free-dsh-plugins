/**
 * 两半与纯逻辑层共用的形状。
 *
 * 类型集中在一个模块，因为这四块是分开写的却必须严丝合缝：规则文件、
 * 分诊编排、HTTP 路由与设置页。这里不认识 cordis、不认识 `node:*`、也不认识
 * DOM——浏览器半边会内联它，所以只有纯类型与常量。
 *
 * @module @free-lzj/dsh-mail/triage/types
 */

import type {
  ActionMode, PendingRecord as CorePending, Rule as CoreRule, Run as CoreRun,
} from '@free-lzj/dsh-decision'

/* ───────────────────────── 对 mail 插件的结构依赖 ───────────────────────── */

/**
 * 分诊要用的那部分邮件摘要。
 *
 * 结构化声明而不是 import `@free-lzj/dsh-mail` 的包：邮件插件是**可选**依赖，
 * 把它写进 dependencies 会把「没装邮件插件」变成一个编译期问题，而它其实是正常
 * 的运行态（`rules/design-patterns.md`：消费方不得把可选插件写成硬依赖）。
 */
export interface MailSummaryLike {
  readonly accountId: string
  readonly folder: string
  readonly uid: number
  readonly uidValidity: number
  readonly subject: string
  readonly from: { readonly address: string; readonly name?: string }
  readonly date: string
  readonly seen: boolean
  readonly flagged: boolean
  readonly hasAttachments: boolean
  readonly snippet: string
  /**
   * 分诊用的邮件头。
   *
   * 这是「按仓库分流」能做成确定性规则的原因：GitHub 的 `list-id` 形如
   * `Owner/Repo <repo.owner.github.com>`，仓库名直接可读。缺失的头部不出现在
   * 这里（不是空串），所以 `headers.x === undefined` 与 `=== ''` 意思不同。
   */
  readonly headers: Readonly<Record<string, string | undefined>>
}

/** 邮件插件能执行的动作；与它的 `MailAction` 同形。 */
export type MailActionLike =
  | {
      readonly op: 'markRead' | 'markUnread' | 'flag' | 'unflag' | 'delete'
      readonly accountId: string
      readonly folder: string
      readonly uids: readonly number[]
    }
  | {
      readonly op: 'move'
      readonly accountId: string
      readonly folder: string
      readonly uids: readonly number[]
      readonly targetFolder: string
    }

/** 邮件插件暴露给别的插件的那几个动词。 */
export interface MailLike {
  accounts(): readonly { readonly id: string; readonly name: string; readonly address: string }[]
  listMailboxes(accountId: string): Promise<readonly { readonly path: string; readonly specialUse?: string }[]>
  ensureFolder(
    accountId: string,
    path: string,
  ): Promise<{ ok: true; path: string } | { ok: false; code: string; message: string }>
  applyAction(action: MailActionLike): Promise<{ ok: true; applied?: number } | { ok: false; code: string; message: string }>
  fetchDetail(
    accountId: string,
    folder: string,
    uid: number,
  ): Promise<
    | {
        readonly text: string
        readonly subject: string
        readonly from: { readonly address: string; readonly name?: string }
        readonly date: string
        readonly snippet: string
      }
    | undefined
  >
}

/* ───────────────────────────────── 条件 ────────────────────────────────── */

/** 条件的种类；每一种在 `src/conditions.ts` 里有一个实现。 */
export type ConditionKind =
  | 'from'
  | 'to'
  | 'subject'
  | 'body'
  | 'header'
  | 'regex'
  | 'attachment'
  | 'classifier'

/**
 * 一条条件的配置。
 *
 * `kind` 决定其余字段怎么读，所以这里是一个可辨识联合的「扁平」形态：YAML 里
 * 用户写的是一个对象，收窄发生在 `src/config.ts`。字段全部可选是刻意的——一个
 * 写歪的条件应当被**丢弃并告警**，而不是让整份规则文件不可用。
 */
export interface ConditionSpec {
  readonly kind: ConditionKind
  /** 匹配值；组内 OR、组间 AND。`header` 时是与 `name` 配对的期望值。 */
  readonly any?: readonly string[]
  /** `header`：头部名，小写（`list-id`、`x-github-reason`）。 */
  readonly name?: string
  /** `regex`：对哪个字段做正则。 */
  readonly field?: 'from' | 'to' | 'subject' | 'body'
  /** `regex`：源串，形如 `^\\[Free-LZJ/`（不带斜杠定界）。 */
  readonly pattern?: string
  /** `attachment`：要求有没有附件。 */
  readonly has?: boolean
  /** `attachment`：按后缀筛选（小写，含点）。 */
  readonly extensions?: readonly string[]
  /** `classifier`：可选标签集；返回不在这集合里就视为未命中。 */
  readonly labels?: readonly string[]
  /** `classifier`：给模型的额外说明，追加在发货提示词之后。 */
  readonly prompt?: string
}

/* ───────────────────────────────── 动作 ────────────────────────────────── */

/** 动作的种类；每一种在 `src/actions/` 下有一个实现文件。 */
export type ActionKind =
  | 'markRead'
  | 'flag'
  | 'move'
  | 'archive'
  | 'notify'
  | 'session'
  | 'followup'
  | 'script'
  | 'mcp'
  | 'http'

/**
 * 一个动作的三态。
 *
 * `auto` 直接做，`suggest` 只通知并等人点，`off` 跳过。默认值按「能不能撤销」
 * 定：IMAP 动作与开会话都可逆或有记录，所以 `auto`；跑脚本、调 MCP、发 HTTP
 * 不可撤销，所以默认 `suggest`。
 */
export type { ActionMode } from '@free-lzj/dsh-decision'

/** 一个动作的配置。字段名是契约，`src/actions/*` 按名字读。 */
export interface ActionSpec {
  readonly kind: ActionKind
  readonly mode?: ActionMode
  /** 覆盖全局撤销窗口；0 = 立即执行。 */
  readonly delaySeconds?: number
  /** `move` / `archive`：目标文件夹路径。 */
  readonly folder?: string
  /** `notify`：标题模板与语气。 */
  readonly title?: string
  readonly tone?: 'info' | 'success' | 'warn' | 'error'
  /** `session`：固定工作目录（绝对路径）。 */
  readonly workspacePath?: string
  /**
   * `session`：带占位符的工作目录，支持 `{repo}`。
   *
   * `{repo}` 从 `list-id` 解析（`Owner/Repo <repo.owner.github.com>` 的第二段），
   * 这是「GitHub 通知落到对应仓库工作区」不需要模型的原因。解析不出来时动作
   * **失败**而不是退化成空串——用一个空目录建会话比不建更糟。
   */
  readonly workspaceTemplate?: string
  readonly agentPreset?: string
  readonly permissionPreset?: string
  readonly titleTemplate?: string
  /** `session`：追加给 agent 的约束，拼在发货提示词之后。 */
  readonly instructions?: string
  /**
   * `followup`：投递到哪个**已存在**的会话。
   *
   * 这是「新建会话」之外的另一种交代：一个常驻的邮箱助手会话比每封邮件开一个新会话
   * 更省，适合「先攒着、需要时一起看」的用法。写错了会话 id 时动作失败并说明，
   * 不会退化成新建一个。
   */
  readonly sessionId?: string
  /** `script`：可执行文件；与 `args` 一起交给 spawn，**不经过 shell**。 */
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** `mcp`：工具全名 `mcp__<server>__<tool>`。 */
  readonly tool?: string
  /** `mcp`：工具入参；值里的 `{subject}` 之类占位符会被替换，**不含邮件正文**。 */
  readonly input?: Readonly<Record<string, unknown>>
  /** `http`：目标地址与方法。 */
  readonly url?: string
  readonly method?: 'POST' | 'PUT'
}

/* ───────────────────────────────── 规则 ────────────────────────────────── */

/**
 * 一条规则。
 *
 * 结构与优先级顺序归内核（`@free-lzj/dsh-decision`）；这里只把两个词表位置填成
 * 邮件的条件配置与动作配置。
 */
export type Rule = CoreRule<ConditionSpec, ActionSpec>


/* ──────────────────────────────── 命中记录 ─────────────────────────────── */

/*
 * 命中记录本身归内核（`@free-lzj/dsh-decision`）：它只管「写下来、读回来、按天裁」，
 * 不认识邮件。这里只说明**一封邮件在这条记录里长什么样**。
 */

/** 记录里那封邮件：够人读懂，也够重读它（`accountId` + `uid`）。 */
export interface MailEvent {
  readonly accountId: string
  readonly folder: string
  readonly uid: number
  readonly uidValidity: number
  readonly from: string
  readonly subject: string
}

/** 一条以邮件为输入的命中记录。 */
export type Run = CoreRun<MailEvent>

export type { RunAction, RunStatus } from '@free-lzj/dsh-decision'



/** 排着队等撤销窗口过去的动作。 */
export interface PendingAction extends CorePending {
  readonly runId: string
  readonly action: ActionSpec
  readonly ruleId: string
  /**
   * 它为什么在这里。
   *
   * `undo` 是「等撤销窗口过去再执行」；`suggest` 是「等人点同意，不点就永远不做」。
   * 两者共用一份队列与一份持久化，但**只有 `undo` 会被到期扫描取走**——否则一条
   * 建议会在两分钟后悄悄变成自动执行，那正是「建议」这个词不该有的意思。
   */
  readonly kind: 'undo' | 'suggest'
  /** 建议对应的那个工作台条目 id（只有 `suggest` 有）：点按钮时拿它反查该做什么。 */
  readonly itemId?: string
  /** 它是 `rule.then` 里的第几个；执行完要回填那条命中记录的这一项。 */
  readonly actionIndex: number
  /** 记录里显示的那几个字段。 */
  readonly message: Run['event']
  /**
   * 重放这次动作需要的邮件摘要。
   *
   * 存摘要而不是等 120 秒后再去 IMAP 读一遍：那时候邮件可能已被别的客户端移走或
   * 删掉，而摘要在到达时就已在内存里。它**不含正文**——磁盘上不留邮件内容。
   */
  readonly summary: MailSummaryLike
  /** 排队时的账号名：message 里只有 id，延迟执行时拿不到名字。旧记录没有它。 */
  readonly accountName?: string
}

/* ──────────────────────────────── 插件配置 ─────────────────────────────── */

/** 一条命中记录最多留几天。 */
export const DEFAULT_RUN_RETENTION_DAYS = 30

/** 最多留多少条命中记录。 */
export const DEFAULT_RUN_HISTORY_LIMIT = 500

/** 有副作用的动作默认等多久才真正执行（秒）。 */
export const DEFAULT_UNDO_WINDOW_SECONDS = 120

/** 规则文件里能出现的一切；YAML 的顶层就是一个规则数组。 */
export interface RulesFile {
  /** 规则文件版本；不认识的值会拒绝加载而不是猜。 */
  readonly version: 1
  readonly rules: readonly Rule[]
}

/** Loader 行的配置。规则本身在文件里，不在这行。 */
export interface Config {
  /** 总开关。关掉后只记录命中，不执行任何动作。 */
  readonly enabled: boolean
  /** 只记录不动作，用于上线前观察。 */
  readonly dryRun: boolean
  /** 有副作用动作的默认撤销窗口（秒）；0 = 立即执行。 */
  readonly undoWindowSeconds: number
  /** 命中记录保留条数。 */
  readonly runHistoryLimit: number
  readonly runRetentionDays: number
  /**
   * 你的 git 仓库都放在哪个目录下。
   *
   * 发货的 GitHub 规则用它把 `List-Id` 里的仓库名变成一个真实路径
   * （`{repoRoot}/{repo}`）。这是整套配置里**唯一**一个机器相关的值——规则本身、
   * 提示词、动作都不需要你改。路径不存在时那条规则的动作会失败并说明原因，
   * 而不是试图猜一个目录。
   */
  readonly repoRoot: string
}

/** 解析或校验规则文件时的结构化错误；`line` 有值时页面能指到行。 */
export interface RuleFileError {
  readonly message: string
  readonly line?: number
}

/* ───────────────────────── 面板要读的视图 ───────────────────────── */

/** 一次写操作的结果。 */
export interface TriageResult {
  readonly ok: boolean
  readonly message?: string
}

/**
 * 面板读规则时拿到的视图。
 *
 * `config` 一起带出来是因为页面要显示那几个只读的全局开关：它们属于 Loader 行，
 * 页面改不了，但「现在到底开着没有」必须看得见。
 */
export interface RulesView {
  readonly rules: readonly Rule[]
  /** 解析失败时的错误；此时 `rules` 是上一份可用的。 */
  readonly error?: RuleFileError
  readonly source: 'file' | 'default'
  readonly path: string
  /** 文件原文，页面拿它做「复制给 agent 的修改指令」。 */
  readonly raw: string
  /** 被丢弃的条目说明（写歪的规则）。 */
  readonly dropped: readonly string[]
  readonly config: Config
}

/** 试跑的结果：会命中哪条规则、会做什么。 */
export interface TestView {
  readonly ruleId: string
  readonly ruleName: string
  readonly actions: readonly { readonly kind: string; readonly detail: string }[]
  readonly reason: string
}

/**
 * 分诊路由要用到的插件能力。
 *
 * 注入进来，所以 HTTP 那一层不需要规则文件、也不需要宿主就能测；`packages/mail/src/routes.ts`
 * 只负责路径、守卫与状态码。
 */
export interface TriageRouteHost {
  /** 当前规则与它的来源状态。 */
  rules(): Promise<RulesView>
  /** 开关一条规则。 */
  setEnabled(ruleId: string, enabled: boolean): Promise<TriageResult>
  /** 改一条规则里某个动作的三态。 */
  setMode(ruleId: string, actionIndex: number, mode: string): Promise<TriageResult>
  /** 改一条规则里某个条件的匹配值列表（只改值，不改种类）。 */
  setCondition(ruleId: string, conditionIndex: number, values: readonly string[]): Promise<TriageResult>
  /** 把一条规则上移或下移。 */
  movePriority(ruleId: string, direction: 'up' | 'down'): Promise<TriageResult>
  /** 命中记录，`since` 之后的新记录（没有 `since` 时给最近一批）。 */
  runs(since?: string): Promise<{ readonly runs: readonly Run[] }>
  /** 撤销一条记录。 */
  undo(runId: string): Promise<TriageResult>
  /** 拿一封已缓存的邮件试跑规则。 */
  test(accountId: string, folder: string, uid: number): Promise<TestView | TriageResult>
}