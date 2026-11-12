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
import type { ActionNode, ActionOutcome, ActionSpecLike, TaskContext } from '@free-lzj/dsh-decision'
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
}

/** 投递到已有会话的配置。 */
export interface FollowupSpec extends ActionSpecLike {
  /** 目标会话 id；必填，写错就失败，绝不偷偷新建。 */
  readonly sessionId?: string
  /** 投递内容；缺省用事件投影里的 `prompt`。 */
  readonly prompt?: string
}

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
    }
  },
})

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
