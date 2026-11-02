/**
 * The workbench's session capability, handed to connectors.
 *
 * A connector (mail today) knows *what* a session should say and where it should
 * run; it must not know *how* this host creates one. That was the bug: mail
 * shipped its own `agents.createSession` port, which does not exist on this
 * host, while the one proven path — `sessionController` — sat in mail's
 * classifier only.
 *
 * This port is the workbench's half of the contract: the same
 * `SessionPort` shape the decision kernel already asks for, implemented with
 * `sessionController`, plus one workbench-side effect: adopting the session as a
 * board card so the workbench shows real work instead of only a rules log.
 *
 * @module @free-dsh-plugins/dsh-console/workbench/session-port
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchCard } from '../protocol.ts'
import type { WorkbenchBoard } from './board.ts'

/** One live agent, as far as this port cares. */
export interface ControllerAgentLike {
  readonly session?: {
    readonly id?: string
    /** Host's own write entry; used for `session/title` when `rename` is absent. */
    append?(type: string, data: unknown): unknown
  }
  followup(message: unknown): unknown
}

/**
 * The session controller methods this port drives.
 *
 * Structurally typed and resolved at call time: the service is optional and may
 * appear after this plugin (the same rule the rest of the workbench follows).
 */
export interface SessionControllerLike {
  create(request: {
    readonly cwd: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: string }>
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<
    | { readonly agent: ControllerAgentLike }
    | { readonly error: unknown }
  >
}

/** The session verbs a connector may call; identical to the decision kernel's port. */
export interface WorkbenchSessionPort {
  createSession(request: {
    readonly cwd: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: string }>
  attachSession(cwd: string, sessionId: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  setPermission(sessionId: string, preset: string): void
  followup(sessionId: string, text: string, source: Readonly<Record<string, unknown>>): Promise<void>
}

/** The longest assistant text kept as one board log line. */
const LOG_LIMIT = 1200

/**
 * Build the port over the host's session controller.
 *
 * The object is always returned; a deployment without the controller gets a
 * sentence-shaped failure at the call, not a half-registered action.
 * @param ctx - the Host context.
 * @param board - the board that adopts sessions as cards.
 * @returns the port.
 */
export function createWorkbenchSessionPort(ctx: Context, board: WorkbenchBoard): WorkbenchSessionPort {
  /** Session id → the title the connector gave it. */
  const titles = new Map<string, string>()
  /** Sessions this port created (and therefore may adopt as cards). */
  const createdIds = new Set<string>()
  /** Sessions whose events are already being followed. */
  const watched = new Set<string>()
  /** The controller, read at call time because it may mount after this plugin. */
  const controller = (): SessionControllerLike | undefined =>
    ctx.get('sessionController') as SessionControllerLike | undefined

  /**
   * Start following one session's events: assistant text into the card log,
   * `turn/end` into the card's final status.
   * @param sessionId - the host session id.
   */
  const watch = (sessionId: string): void => {
    if (watched.has(sessionId)) return
    watched.add(sessionId)
    ctx.on('session/event', (session: { readonly id?: string }, event: unknown) => {
      if (session?.id !== sessionId) return
      const type = (event as { readonly type?: string }).type
      if (type === 'assistant/message') {
        const text = assistantText((event as { readonly data?: unknown }).data)
        if (text !== '') board.appendSessionLog(sessionId, text.slice(0, LOG_LIMIT))
        return
      }
      if (type !== 'turn/end') return
      const reason = (event as { readonly data?: { readonly reason?: { readonly kind?: string } } }).data?.reason
      watched.delete(sessionId)
      board.finishSession(sessionId, reason?.kind === 'completed' ? 'done' : 'failed')
    })
  }

  /**
   * Read the assistant text out of one durable event.
   *
   * The host wraps the message (`data.message.content`); the older `data.content`
   * shape is kept as a fallback so a host that flattens it still works.
   * @param data - the event data.
   * @returns the concatenated text blocks.
   */
  const assistantText = (data: unknown): string => {
    if (typeof data !== 'object' || data === null) return ''
    const record = data as Record<string, unknown>
    const message = record['message']
    const content = (typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>)['content']
      : undefined) ?? record['content']
    if (!Array.isArray(content)) return ''
    return content
      .filter((block): block is { readonly type?: string; readonly text?: string } =>
        typeof block === 'object' && block !== null)
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
      .trim()
  }

  /**
   * Which board source one action's provenance names.
   * @param source - the source record the action passed.
   * @returns a card source id.
   */
  const cardSource = (source: Readonly<Record<string, unknown>>): WorkbenchCard['source'] => {
    const form = typeof source['form'] === 'string' ? source['form'] : ''
    if (form === 'mail' || source['plugin'] === 'dsh-mail') return 'mail'
    if (form === 'jira') return 'jira'
    if (form === 'webhook') return 'webhook'
    return 'manual'
  }

  /**
   * 这次派生来自哪封邮件。
   *
   * 邮件的会话动作会把 `accountId/folder/uid` 放进 source（`mail/src/triage/actions/
   * session.ts`）；以前这里只取了 `form`，邮件身份就丢了，会话卡只能自成一链。
   * @param source - the source record the action passed.
   * @returns 邮件的 uid，字符串形式；不是邮件来源时 undefined。
   */
  const mailUidOf = (source: Readonly<Record<string, unknown>>): string | undefined => {
    const uid = source['uid']
    if (typeof uid === 'string' && uid !== '') return uid
    if (typeof uid === 'number' && Number.isFinite(uid)) return String(uid)
    return undefined
  }

  return {
    async createSession(request) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController），无法新建会话')
      const created = await service.create(request)
      createdIds.add(created.sessionId)
      watch(created.sessionId)
      return { sessionId: created.sessionId }
    },

    // The host attaches the directory at creation; this version has no separate verb.
    async attachSession() {},

    async rename(sessionId, title) {
      titles.set(sessionId, title)
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController）')
      if (service.rename !== undefined) {
        await service.rename({ sessionId, title })
        return
      }
      const resolved = await service.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`会话 ${sessionId} 不可用`)
      resolved.agent.session?.append?.('session/title', {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    },

    setPermission() {
      // Permission is a session event in this host version; the action layer only
      // carries an id, so this stays an explicit no-op instead of a fake success.
    },

    async followup(sessionId, text, source) {
      const service = controller()
      if (service === undefined) throw new Error('这个部署没有会话服务（sessionController）')
      const resolved = await service.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`会话 ${sessionId} 不可用：${describe(resolved.error)}`)
      resolved.agent.followup({
        role: 'user',
        content: [{ type: 'text', text }],
        source,
      })
      // Only sessions this port created become cards; a follow-up into someone
      // else's standing session keeps its own row and does not get a new card.
      if (!createdIds.has(sessionId)) return
      const title = titles.get(sessionId) ?? `会话 ${sessionId.slice(0, 8)}`
      // 调用方带了 `rootId` 就归到那条链；没带时：先按邮件 uid 找那封邮件的卡
      // （邮件动作的 source 里有 accountId/folder/uid，只是从前被丢掉了），
      // 再按 sessionId 找已经登记过的会长。
      const explicit = typeof source['rootId'] === 'string' && source['rootId'] !== '' ? source['rootId'] : undefined
      const uid = mailUidOf(source)
      const rootId = explicit
        ?? (uid === undefined ? undefined : board.rootOfMailUid(uid))
        ?? board.rootOfSession(sessionId)
      board.recordSessionCard({
        sessionId,
        title,
        source: cardSource(source),
        ...(rootId === undefined ? {} : { rootId }),
        ...(typeof source['ruleId'] === 'string' ? { ruleName: source['ruleId'] } : {}),
      })
    },
  }
}

/** One error as a sentence. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
