/**
 * Handing one matched message to dsh — the trigger half of the mail plugin.
 *
 * Three modes, configured per account: start a new root session (§6 mode A),
 * deliver a notice into an existing one (mode B), or leave it to the panel
 * (mode C). The call order in mode A is not ours to pick — `attachSession`
 * verifies the session header that `agents.create` has already written with the
 * workspace as its cwd — so a change here has to keep that order intact.
 *
 * Nothing here imports cordis: the host services arrive as {@link TriggerHost},
 * which keeps the ordering and the cleanup testable with a fake.
 *
 * @module @free-lzj/dsh-mail/trigger
 */

import { randomUUID } from 'node:crypto'
import { buildPrompt, renderTitle, triggerReadiness, type TriggerAvailability } from './rules.ts'
import type { MailSummary, RouteResult, TriggerConfig } from './types.ts'

/** Everything the trigger needs from the host. Injected so tests never touch cordis. */
export interface TriggerHost {
  readonly permissions: {
    resolve(name: string): unknown
    set(session: unknown, name: string): void
    readonly names: readonly string[]
    readonly defaultPreset?: string
  }
  readonly agentPresets: {
    resolve(id?: string): Promise<{ id: string; broken?: string }>
    acquireScope(id?: string): Promise<{ [Symbol.asyncDispose](): Promise<void> }>
    mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
  }
  readonly workspaces: {
    create(
      absPath: string,
      title?: string,
    ): Promise<{ path: string; attachSession(id: string): Promise<void>; detachSession(id: string): Promise<void> }>
  }
  readonly agents: {
    create(
      options: Record<string, unknown>,
    ): Promise<{ agent: { session: unknown; followup(input: unknown): void }; dispose(): Promise<void> }>
  }
  readonly titles: { rename(session: unknown, title: string): unknown }
  readonly sessions?: {
    resolveAgent(
      sessionId: string,
    ): Promise<{ agent: { followup(input: unknown): void } } | { error: unknown }>
  }
  readonly defaultModel: { currentSelection(): { provider: string; model: string } }
  readonly log: (message: string) => void
}

/** The failure codes `fire` normalizes every throw into. */
type FailureCode = 'session_failed' | 'session_not_found' | 'preset_not_found' | 'invalid_config'

/**
 * The message the plugin posts into a session.
 *
 * Built here rather than through `@deepseek-ai/dsh-llm`'s `createUserMessage`:
 * the Host bundle has no externals, so importing the helper would inline a second
 * copy of that library into `lib/index.js`.
 * @param text - the prompt body.
 * @param accountId - the account the message arrived on.
 * @param summary - the message it came from.
 * @returns a user-role message shaped the way the session service expects.
 */
function mailMessage(text: string, accountId: string, summary: MailSummary): unknown {
  // ponytail: the real helper is three lines plus a clone/freeze; if UserMessage
  // grows a required field, this has to follow.
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'email',
      accountId,
      folder: summary.folder,
      uid: summary.uid,
      form: 'notice',
    },
  }
}

/**
 * The text of a failure, whatever the host threw.
 * @param error - the caught value.
 * @returns a message safe to show in the panel.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return String(error)
}

/**
 * Whether a service object exists and carries the methods we are about to call.
 * @param service - the candidate, as `ctx.get` would hand it over.
 * @param methods - the methods this mode needs.
 * @returns true when every method is callable.
 */
function wired(service: unknown, ...methods: readonly string[]): boolean {
  if (typeof service !== 'object' || service === null) return false
  return methods.every(name => typeof (service as Record<string, unknown>)[name] === 'function')
}

/**
 * Which of the optional host services are present (drives the settings drawer).
 * @param host - the host slice, possibly missing whole services.
 * @returns availability per mode; the panel mode needs nothing.
 */
export function triggerAvailability(host: Partial<TriggerHost>): { session: boolean; notify: boolean } {
  return {
    session:
      wired(host.permissions, 'resolve', 'set') &&
      wired(host.agentPresets, 'resolve', 'acquireScope', 'mount') &&
      wired(host.workspaces, 'create') &&
      wired(host.agents, 'create') &&
      wired(host.titles, 'rename') &&
      wired(host.defaultModel, 'currentSelection'),
    notify: wired(host.sessions, 'resolveAgent'),
  }
}

/** One account's trigger, wired to the host it was created with. */
export interface Triggerer {
  /** Hand one matched message over. Never throws. */
  fire(accountId: string, trigger: TriggerConfig, summary: MailSummary, body: string): Promise<RouteResult>
}

/**
 * Build the triggerer for one host.
 *
 * Mode A runs the steps in the only order that works: validate the permission
 * preset before touching anything, resolve the agent preset, hold its scope for
 * the whole conversation setup, then create the session and only afterwards
 * attach it to the workspace. A failure past `agents.create` rolls both back on
 * a best-effort basis — a half-attached workspace outlives the failure
 * otherwise, and a retry would build a second session.
 * @param host - the host services.
 * @returns the triggerer the routes and the IMAP loop call.
 */
export function createTriggerer(host: TriggerHost): Triggerer {
  /** Answer with a normalized failure and leave a line in the log. */
  function fail(code: FailureCode, message: string): RouteResult {
    host.log(`[mail] trigger failed (${code}): ${message}`)
    return { ok: false, code, message }
  }

  /** Mode B: deliver into a session that already exists. */
  async function fireNotify(
    accountId: string,
    trigger: TriggerConfig,
    summary: MailSummary,
    body: string,
  ): Promise<RouteResult> {
    const sessions = host.sessions
    const target = trigger.notify?.sessionId
    if (sessions === undefined) return fail('invalid_config', '未挂载会话服务（sessionController），无法投递提醒')
    if (target === undefined || target.trim() === '') {
      return fail('invalid_config', '未配置目标会话：mode=notify 需要 notify.sessionId')
    }
    // resolveAgent resumes a sleeping session and never throws: `'error' in` is
    // the only correct way to read a failure out of it.
    const resolved = await sessions.resolveAgent(target)
    if ('error' in resolved) return fail('session_not_found', messageOf(resolved.error))
    resolved.agent.followup(mailMessage(buildPrompt(summary, body, trigger.promptTemplate), accountId, summary))
    return { ok: true }
  }

  /** Mode A: one new root session for one message. */
  async function fireSession(
    accountId: string,
    trigger: TriggerConfig,
    summary: MailSummary,
    body: string,
  ): Promise<RouteResult> {
    const options = trigger.session
    if (options === undefined) return fail('invalid_config', '未配置新建会话参数：mode=session 需要 session')

    // Sync and first, so a preset name that does not exist fails before a
    // workspace or a session is created.
    const permissionName = options.permissionPreset ?? host.permissions.defaultPreset
    if (permissionName !== undefined) {
      try {
        host.permissions.resolve(permissionName)
      } catch (error) {
        return fail('invalid_config', `未知的权限预设 ${permissionName}：${messageOf(error)}`)
      }
    }

    let preset: { id: string; broken?: string }
    try {
      preset = await host.agentPresets.resolve(options.agentPreset)
    } catch (error) {
      return fail('preset_not_found', `无法解析 agent 预设 ${options.agentPreset ?? '(默认)'}：${messageOf(error)}`)
    }

    const scope = await host.agentPresets.acquireScope(preset.id)
    try {
      const workspace = await host.workspaces.create(options.workspacePath)
      const selected = host.defaultModel.currentSelection()
      const sessionId = `mail-${randomUUID()}`
      const handle = await host.agents.create({
        sessionId,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        agentOptions: { provider: selected.provider, model: selected.model },
        setup: async (agentCtx: unknown) => {
          await host.agentPresets.mount(agentCtx, preset.id)
        },
      })
      try {
        await workspace.attachSession(sessionId)
        if (permissionName !== undefined) host.permissions.set(handle.agent.session, permissionName)
        host.titles.rename(handle.agent.session, renderTitle(options.titleTemplate, summary))
        handle.agent.followup(mailMessage(buildPrompt(summary, body, trigger.promptTemplate), accountId, summary))
      } catch (error) {
        // Best effort, both of them: the original failure is the one worth
        // reporting, so neither cleanup may replace it.
        await workspace.detachSession(sessionId).catch(() => {})
        await handle.dispose().catch(() => {})
        throw error
      }
      return { ok: true }
    } finally {
      await scope[Symbol.asyncDispose]()
    }
  }

  return {
    async fire(
      accountId: string,
      trigger: TriggerConfig,
      summary: MailSummary,
      body: string,
    ): Promise<RouteResult> {
      try {
        const available: TriggerAvailability = triggerAvailability(host)
        const readiness = triggerReadiness(trigger, available)
        if (!readiness.ok) return fail('invalid_config', readiness.reason ?? '触发配置不可用')
        switch (trigger.mode) {
          case 'panel':
            return { ok: true }
          case 'notify':
            return await fireNotify(accountId, trigger, summary, body)
          case 'session':
            return await fireSession(accountId, trigger, summary, body)
        }
      } catch (error) {
        return fail('session_failed', messageOf(error))
      }
    },
  }
}
