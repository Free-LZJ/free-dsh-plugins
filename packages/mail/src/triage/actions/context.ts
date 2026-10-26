/**
 * 动作层与宿主之间的那道接口。
 *
 * 动作实现只认这一组端口，不认 cordis、不认 imapflow、不认 child_process。两个
 * 好处都很实际：测试用假端口就能把「调用顺序、失败路径、撤销」跑完；而宿主 API
 * 漂移时只需改一处适配，不必碰九个动作实现。
 *
 * 注意 `session` 端口的形状是**编排过的动词**（`createSession` → `attachSession`
 * → `rename` → `setPermission` → `followup`），不是原始的宿主服务：这个顺序在
 * `packages/mail/src/trigger.ts` 里被验证过（先建会话才能 attach、权限必须在第一条
 * 消息之前挂上），不该让每个动作实现各自再拼一遍。
 *
 * @module @free-lzj/dsh-mail/triage/actions/context
 */

import type { ActionKind, ActionMode, ActionSpec, MailSummaryLike, Rule } from '../types.ts'

/** 这次动作处理的那封邮件。 */
export interface ActionTask {
  readonly accountId: string
  readonly accountName: string
  readonly summary: MailSummaryLike
  /** 已读取的正文；`needsBody` 的动作拿到的是它，其余动作也可能需要（如开会话）。 */
  readonly body: string
  readonly rule: Rule
}

/** 建会话要走的那一串动词。 */
export interface SessionPort {
  /** 建一个根会话；返回它的 id。 */
  createSession(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
  /** 把会话挂到这个目录的工作区下（宿主会 realpath 校验，顺序不能反）。 */
  attachSession(cwd: string, sessionId: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  /** 把权限预设挂到会话上；必须在第一条消息之前。 */
  setPermission(sessionId: string, preset: string): void
  /** 投递第一条消息。 */
  followup(sessionId: string, text: string, source: Readonly<Record<string, unknown>>): Promise<void>
}

/** 工作台通知。 */
export interface ConsolePort {
  /** 一条纯通知：只告诉人，不需要他做什么。 */
  notify?(notice: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
  }): Promise<unknown>
  /**
   * 一条**条目**：告诉人，并且给他一个能点的动作。
   *
   * 与 `notify` 的差别就是「能被处理」：条目有身份（返回 `id`），点出来的动作会被
   * 路由回举起它的插件。`suggest` 三态走这一条——一条点不动的建议等于没建议。
   * @param item - 标题、动作，以及归属的 kind。
   * @returns 条目 id；工作台没装或太旧时返回 undefined。
   */
  raise?(item: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
    readonly kind: string
    readonly actions: readonly { readonly id: string; readonly label: string; readonly style?: 'primary' | 'danger' }[]
    readonly sessionId?: string
  }): Promise<{ readonly id: string } | undefined>
  /**
   * 记一条「我自己做过的事」。
   *
   * 与 `raise` 分开是刻意的：一天归档二十封推广的人不该收到二十条要处理的条目。这条
   * 通道只进工作台的**自动化日志**——封顶、不打角标、不打扰，需要时再翻。
   * @param entry - 做了什么、对什么、成不成。
   */
  log?(entry: {
    readonly source: string
    readonly title: string
    readonly detail?: string
    readonly ok?: boolean
  }): void
}

/** 跑一个外部命令；`args` 是数组，**不经过 shell**。 */
export interface SubprocessPort {
  spawn(spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
  }): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>
}

/** 调一个 MCP 工具，名字是宿主给的 `mcp__<server>__<tool>` 全名。 */
export interface ToolPort {
  call(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** 发一个 HTTP 请求。 */
export type FetchPort = (
  url: string,
  init: { readonly method: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<{ readonly ok: boolean; readonly status: number }>

/**
 * 一次动作执行能用到的一切。
 *
 * 全部可选：分诊在只有邮件插件、没有工作台、没有会话能力的部署里也该能工作，缺
 * 能力时动作**失败并说明缺什么**，而不是静默跳过——静默跳过会让人以为规则没生效。
 */
export interface ActionContext {
  readonly task: ActionTask
  /**
   * 全局可替换值，来自 Loader 行配置（目前是 `repoRoot`）。
   *
   * 与邮件头分开：头部是**这封信说的**，变量是**这台机器配的**。模板里两者都能用，
   * 但只有前者来自不可信来源。
   */
  readonly vars: Readonly<Record<string, string>>
  readonly mail?: {
    /** 账号的文件夹列表；`archive` 用它找 `\Archive`。 */
    listMailboxes(accountId: string): Promise<readonly { readonly path: string; readonly specialUse?: string }[]>
    ensureFolder(accountId: string, path: string): Promise<{ ok: true; path: string } | { ok: false; code: string; message: string }>
    applyAction(action: unknown): Promise<{ ok: true; applied?: number } | { ok: false; code: string; message: string }>
  }
  readonly sessions?: SessionPort
  readonly console?: ConsolePort
  readonly subprocess?: SubprocessPort
  readonly tools?: ToolPort
  readonly fetch?: FetchPort
  readonly log: (message: string) => void
}

/** 一个动作执行完的结果。 */
export interface ActionOutcome {
  readonly ok: boolean
  /** 命中记录里显示的一行中文说明（含失败原因）。 */
  readonly detail: string
  /** 建出的会话 id；页面据此让人点进去。 */
  readonly sessionId?: string
  /**
   * 撤销这次动作。
   *
   * 只有「能回到原样」的动作才提供它：标记已读可以标回去、移动可以移回来；跑脚本、
   * 调 MCP、建会话都收不回来，所以它们没有这个字段。
   */
  readonly undo?: () => Promise<void>
}

/**
 * 一个动作实现。
 *
 * `sideEffect` 决定**默认三态**（见 `src/config.ts` 的 `DEFAULT_MODE`）：不可撤销的
 * 动作默认只「建议」，因为没人看着的时候自动跑一个脚本是不可接受的默认值。
 */
export interface Action {
  readonly kind: ActionKind
  readonly sideEffect: boolean
  /**
   * 执行。
   * @param spec - 已经过 `normalizeAction` 收窄的动作配置。
   * @param context - 这封邮件与可用的宿主能力。
   * @returns 结果；**不要抛**，能力缺失与宿主拒绝都折成 `ok: false` 加一句说明。
   */
  run(spec: ActionSpec, context: ActionContext): Promise<ActionOutcome>
}

/** 各动作共用的失败结果。 */
export function failure(detail: string): ActionOutcome {
  return { ok: false, detail }
}

/** 取动作的三态；缺省由配置层填过，这里只兜底。 */
export function modeOf(spec: ActionSpec): ActionMode {
  return spec.mode ?? 'auto'
}
