/**
 * 会话动作：新建一个项目会话，或投递到一个已有会话。
 *
 * 这两个动作从前住在邮件插件里，现在归 DSH 连接器——**建会话是宿主能力，不是邮件
 * 能力**。邮件那一侧只负责说清「交给谁、说什么」（它把渲染好的开场白放进事件投影），
 * 这里负责「怎么建、建在哪、建完挂哪」。
 *
 * 两条硬约束（沿用内核的判断，这里只是不允许绕过）：
 *
 * 1. **顺序不能换**：建会话 → 登记工作区 → 改名 → 投递。投递一进去，这一轮就已经
 *    按当时的权限在跑了。
 * 2. **会话永不回滚**。建出来就可能已经干了活，失败只如实报告并带回 id。
 *
 * `scope` 是「两类会话」的落点：`workspace`（默认）出现在侧边栏工作区，见
 * `ports.createDshSessionPort` 的登记；`internal` 不建宿主会话，由连接器用别的执行体
 * 完成（本连接器不实现，留位）。
 *
 * @module @free-lzj/dsh-connector-dsh/actions/session
 */

import { fillTemplate, runSession } from '@free-lzj/dsh-decision'
import type { ActionNode, ActionOutcome, ActionSpecLike, SuspendSpec, TaskContext } from '@free-lzj/dsh-decision'
import { defineAction } from '@free-lzj/dsh-decision'
import { describe, failure, portsOf } from '../ports.ts'

/** 新建会话的配置。 */
export interface SessionSpec extends ActionSpecLike {
  /** 绝对路径；与 `workspaceTemplate` 二选一。 */
  readonly workspace?: string
  /**
   * `workspace` 的旧名。
   *
   * 这两个名字是同一件事：动作从邮件插件搬到 DSH 连接器时，用户已经写下的规则里是
   * `workspacePath`。改动作的提供者不该改用户的文件。
   */
  readonly workspacePath?: string
  /** 模板，用事件投影填（例：`{repoRoot}/{repo}`）。 */
  readonly workspaceTemplate?: string
  /** 会话标题模板；缺省 `{rule}：{subject}`。 */
  readonly titleTemplate?: string
  /** 交给 agent 的正文；缺省用事件投影里的 `prompt`。 */
  readonly instructions?: string
  readonly agentPreset?: string
  readonly permissionPreset?: string
  /**
   * 建出来的会话要不要等它干完再往下走。
   *
   * - `none`：发完即走。会话在自己那边跑，流程立刻继续。
   * - `idle`（默认）：会话跑完（宿主报 idle）才继续——「派单会话读完单再推通知」这类
   *   必须等结果。等的时候这一格是**挂起**，看板显示「等回信」，超时（`timeoutMinutes`）
   *   判失败并留下原因。
   */
  readonly awaitSession?: 'none' | 'idle'
  /** 等会话的超时（分钟）；默认 120。 */
  readonly timeoutMinutes?: number
}

/** 投递到已有会话的配置。 */
export interface FollowupSpec extends ActionSpecLike {
  /** 目标会话 id；必填，写错就失败，绝不偷偷新建。 */
  readonly sessionId?: string
  /** 投递内容；缺省用事件投影里的 `prompt`。 */
  readonly prompt?: string
}

/**
 * 「等会话干完」这类挂起的令牌前缀。
 *
 * 唤醒探针（连接器的 `probeWait`）只认这个前缀，别的前缀说明不是它管的等待。
 */
export const SESSION_WAIT_PREFIX = 'session:'

/** 标题上限（字节）；宿主也会截，但先在本地截好，行为可预期。 */
const TITLE_MAX_BYTES = 80

/** 按 UTF-8 字节截断，不切开一个多字节字符。 */
function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= limit) return text
  let cut = text
  while (cut.length > 0 && encoder.encode(cut).length > limit) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** 解析工作目录：模板先查缺值，再填。 */
export function resolveWorkspace(
  spec: { readonly workspace?: string; readonly workspacePath?: string; readonly workspaceTemplate?: string },
  vars: Readonly<Record<string, string>>,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly outcome: ActionOutcome } {
  if (spec.workspaceTemplate !== undefined) {
    // 缺值要在填之前查：`fillTemplate` 把未知占位符填成空串，填完再看什么都看不出来，
    // 于是 `{repoRoot}/{repo}` 会变成一个以 `/` 结尾的路径去建会话——把一个问题记到
    // 另一个目录上，比不开会话难查得多。
    const named = [...spec.workspaceTemplate.matchAll(/\{(\w+)\}/g)].map(match => match[1] as string)
    const missing = named.filter(name => vars[name] === undefined || vars[name] === '')
    if (missing.length > 0) {
      return { ok: false, outcome: failure(`工作目录模板缺少值：${missing.join('、')}`, 'config') }
    }
    return { ok: true, path: fillTemplate(spec.workspaceTemplate, vars) }
  }
  const fixed = spec.workspace ?? spec.workspacePath
  if (fixed === undefined || fixed.trim() === '') {
    return { ok: false, outcome: failure('session 动作缺少 workspace：新建会话必须写明目录', 'config') }
  }
  return { ok: true, path: fixed.trim() }
}

/** 新建会话。 */
export const sessionAction: ActionNode<SessionSpec, TaskContext> = defineAction({
  kind: 'session',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    // 续跑：这一格是「等这个会话跑完」醒过来的，会话早就建好了。再建一遍等于同一条
    // 派单开两个会话——所以只认令牌对得上的那次唤醒，直接报完成。
    const resumed = resumedSession(context.signal)
    if (resumed !== undefined) {
      return {
        ok: true,
        detail: `会话 ${resumed.slice(0, 8)} 已经跑完`,
        sessionId: resumed,
        data: { scope: 'workspace', mode: 'create', resumed: true },
      }
    }
    const ports = portsOf(context)
    const workspace = resolveWorkspace(spec, context.vars)
    if (!workspace.ok) return workspace.outcome
    const title = truncateUtf8(
      `[任务] ${fillTemplate(spec.titleTemplate ?? '{rule}：{subject}', context.vars)}`,
      TITLE_MAX_BYTES,
    )
    const outcome = await runSession(
      {
        workspace: workspace.path,
        title,
        prompt: spec.instructions ?? context.vars['prompt'] ?? '',
        ...(spec.permissionPreset === undefined ? {} : { permissionPreset: spec.permissionPreset }),
        ...(spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset }),
        source: {
          plugin: 'dsh-connector-dsh',
          task: context.task.id,
          ...(context.vars['source'] === undefined ? {} : { form: context.vars['source'] }),
        },
      },
      { sessions: ports.sessions, log: context.log },
    )
    if (!outcome.ok) {
      return {
        ok: false,
        message: outcome.message,
        failure: 'transient',
        ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
        data: { scope: 'workspace', mode: 'create', workspace: workspace.path },
      }
    }
    return {
      ok: true,
      detail: outcome.detail,
      sessionId: outcome.sessionId,
      data: { scope: 'workspace', mode: 'create', workspace: workspace.path },
      ...(spec.awaitSession === 'none'
        ? {}
        : { wait: waitForSession(outcome.sessionId, spec.timeoutMinutes, context.now) }),
    }
  },
})

/**
 * 这次唤醒是不是「我建的那个会话跑完了」。
 *
 * 只认自己发的令牌：别的信号（人工放行、别的等待）不该让这一格跳过建会话。
 * @param signal - 上下文里的唤醒信号。
 * @returns 会话 id；不是本动作的唤醒时 undefined。
 */
function resumedSession(signal: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const sessionId = signal?.['sessionId']
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return signal?.['token'] === `${SESSION_WAIT_PREFIX}${sessionId}` ? sessionId : undefined
}

/**
 * 造一个「等这个会话干完」的挂起说明。
 *
 * 令牌写成 `session:<id>`：唤醒探针（`probeWait`）只认这个前缀，别的等待不会撞上。
 * @param sessionId - 刚建出来的会话。
 * @param minutes - 超时分钟数；没写或写歪用 120。
 * @param now - 现在；跟着任务的时钟走，测试能钉死。
 * @returns 挂起说明。
 */
function waitForSession(sessionId: string, minutes: number | undefined, now: Date): SuspendSpec {
  const timeout = typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 ? minutes : 120
  return {
    on: 'event',
    token: `${SESSION_WAIT_PREFIX}${sessionId}`,
    dueAt: new Date(now.getTime() + timeout * 60_000).toISOString(),
    resume: { sessionId },
    detail: `等会话 ${sessionId.slice(0, 8)} 干完`,
  }
}

/** 投递到一个已有会话。 */
export const followupAction: ActionNode<FollowupSpec, TaskContext> = defineAction({
  kind: 'followup',
  sideEffect: true,
  async run(spec, context): Promise<ActionOutcome> {
    const ports = portsOf(context)
    const sessionId = spec.sessionId?.trim()
    if (sessionId === undefined || sessionId === '') {
      return failure('followup 动作缺少 sessionId：投递到已有会话必须写明目标会话', 'config')
    }
    const text = spec.prompt ?? context.vars['prompt'] ?? ''
    if (text === '') {
      return failure('followup 没有可投递的内容（规则里没写 prompt，事件投影里也没有）', 'config')
    }
    try {
      await ports.sessions.followup(sessionId, text, {
        plugin: 'dsh-connector-dsh',
        task: context.task.id,
        followup: true,
      })
    } catch (error: unknown) {
      // 会话不存在是最常见的失败：宿主在 resolveAgent 里给出错误，原样带出来。
      return failure(`投递到会话 ${sessionId} 失败：${describe(error)}`, 'fatal')
    }
    return {
      ok: true,
      detail: `已投递到会话 ${sessionId.slice(0, 8)}`,
      sessionId,
      data: { scope: 'workspace', mode: 'followup', sessionId, external: true },
    }
  },
})
