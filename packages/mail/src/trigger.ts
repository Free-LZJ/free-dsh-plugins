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
import { buildPrompt, matchesFilters, renderTitle, triggerReadiness, type TriggerAvailability } from './rules.ts'
import type { MailSummary, PresetChoice, RouteResult, TriggerConfig, TriggerRule } from './types.ts'

/** Everything the trigger needs from the host. Injected so tests never touch cordis. */
export interface TriggerHost {
  readonly permissions: {
    resolve(name: string): unknown
    set(session: unknown, name: string): void
    readonly names: readonly string[]
    readonly defaultPreset?: string
    /**
     * The advertised presets with their labels. Optional because a deployment may
     * mount an older service that only publishes `names`; the drawer then falls
     * back to the bare names.
     */
    catalog?(): {
      readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
      readonly defaultPreset: string
    }
  }
  readonly agentPresets: {
    resolve(id?: string): Promise<{ id: string; broken?: string }>
    acquireScope(id?: string): Promise<{ [Symbol.asyncDispose](): Promise<void> }>
    mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
    /** Every declared preset with its display metadata; optional for the same reason as `catalog`. */
    list?(): Promise<readonly {
      readonly id: string
      readonly name?: string
      readonly description?: string
      readonly order?: number
      readonly broken?: string
    }[]>
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

/**
 * The action one message takes, decided against the account's rules.
 *
 * First match wins, in the order the drawer lists them — the only ordering a
 * person can predict from a form, and the same one Gmail's filter list settles
 * on. A message no rule claims stays in the panel: making the account's own
 * `mode` a catch-all would mean a rule list also silently fires for everything
 * it did not name, which is how one over-broad rule starts a session per mail.
 * An account that really wants "everything, except these" can end its list with
 * a rule that has no conditions.
 *
 * `readBody` is a callback rather than a string because only a `keywords`
 * condition needs one: reading a body for messages that are about to be skipped
 * is exactly what the 2 KB list preview exists to avoid. It is paid for at most
 * once, and only after every cheap group has already matched.
 * @param trigger - the account's trigger configuration.
 * @param summary - the message to place.
 * @param readBody - how to read the message's text, when a rule needs it.
 * @returns the trigger to hand to `fire`; `panel` means "leave it in the list".
 */
export async function resolveTrigger(
  trigger: TriggerConfig,
  summary: MailSummary,
  readBody: () => Promise<string>,
): Promise<TriggerConfig> {
  const rules: readonly TriggerRule[] = trigger.rules ?? [{ when: trigger.filters, action: trigger.mode }]
  let body: string | undefined
  for (const rule of rules) {
    // The cheap pass first: everything except the group that may need the body.
    // Dropping the group entirely is what makes this the same predicate the
    // filter would be without its expensive half.
    const { keywords, ...cheap } = rule.when
    if (!matchesFilters(summary, cheap)) continue
    if ((keywords ?? []).length > 0) {
      body ??= await readBody()
      if (!matchesFilters(summary, rule.when, body)) continue
    }
    // A rule that names no session/notify/template options inherits the
    // account's: one workspace for the whole list is the normal case, and
    // repeating it per rule is what makes a list unreadable.
    const session = rule.session ?? trigger.session
    const notify = rule.notify ?? trigger.notify
    const promptTemplate = rule.promptTemplate ?? trigger.promptTemplate
    return {
      mode: rule.action,
      ...(session === undefined ? {} : { session }),
      ...(notify === undefined ? {} : { notify }),
      ...(promptTemplate === undefined ? {} : { promptTemplate }),
      filters: {},
    }
  }
  return { mode: 'panel', filters: {} }
}

/**
 * Chinese labels for the presets this deployment ships.
 *
 * The shipped definitions declare no `name` — checked against a running instance,
 * where every label came back as the bare id. A dropdown of `standard` /
 * `workspace-write` is not the "show the label" the drawer asked for, so these
 * are spelled out here. A deployment that does declare a name wins over this
 * table, and an id nobody here knows falls back to itself: the table only ever
 * fills a gap, it never renames a preset.
 */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  // Agent presets (`dsh-web-app/presets`).
  standard: '标准模式',
  ptc: 'PTC 模式（工具调用写成代码）',
  minimal: '极简模式',
  cordis: 'Cordis 组合模式',
  // Permission presets (`dsh-permission-presets`).
  'read-only': '只读',
  'workspace-write': '仅工作目录可写',
  'danger-full-access': '完全访问（不弹审批）',
}

/** The label for one preset: its declared name, else the table, else the id. */
function presetLabel(id: string, declared: string | undefined): string {
  const named = declared === undefined ? '' : declared.trim()
  if (named !== '' && named !== id) return named
  return PRESET_LABELS[id] ?? id
}
/** The slice of host services that describes which presets exist. */
export interface PresetHost {
  readonly permissions?: {
    readonly names?: readonly string[]
    catalog?(): {
      readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
      readonly defaultPreset: string
    }
  }
  readonly agentPresets?: {
    list?(): Promise<readonly {
      readonly id: string
      readonly name?: string
      readonly description?: string
      readonly order?: number
      readonly broken?: string
    }[]>
  }
}

/**
 * The two preset lists a settings drawer can offer, read from the host.
 *
 * The label is the declared name and falls back to the id: the presets shipped
 * in this deployment declare neither `name` nor `description`, so without the
 * fallback every row would read as an empty string. A preset whose definition
 * failed to load is still listed — hiding it would look like it never existed —
 * with `broken` carrying the reason so the drawer can mark it.
 *
 * Both readers are optional: an older host may publish only `names`, and a
 * registry that throws is not a reason to lose the field entirely.
 * @param host - the host slice, possibly missing the optional readers.
 * @returns the choices for the two fields, in the host's own order.
 */
export async function presetChoices(
  host: PresetHost,
): Promise<{ agents: PresetChoice[]; permissions: PresetChoice[] }> {
  const agents: PresetChoice[] = []
  const list = host.agentPresets?.list
  if (typeof list === 'function') {
    try {
      for (const preset of await list.call(host.agentPresets)) {
        agents.push({
          value: preset.id,
          label: presetLabel(preset.id, preset.name),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        })
      }
    } catch {
      // A registry that cannot answer leaves the list empty; the drawer then
      // says so instead of offering names that would fail at trigger time.
    }
  }

  const permissions: PresetChoice[] = []
  const catalog = host.permissions?.catalog
  if (typeof catalog === 'function') {
    try {
      for (const option of catalog.call(host.permissions).options) {
        permissions.push({
          value: option.value,
          label: presetLabel(option.value, option.name),
          ...(option.description === undefined ? {} : { description: option.description }),
        })
      }
    } catch {
      // Same as above.
    }
  } else {
    for (const name of host.permissions?.names ?? []) permissions.push({ value: name, label: presetLabel(name, undefined) })
  }

  return { agents, permissions }
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
