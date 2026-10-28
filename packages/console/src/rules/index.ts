/**
 * The rule engine's home and its HTTP surface.
 *
 * Two things live here, and they belong together: **where** the workbench keeps
 * the rule state, and the routes its own page reads and writes it through. The
 * engine itself is `@free-lzj/dsh-decision`'s {@link DecisionEngine} — a library
 * that knows how to read a rule file, queue an action and undo it, but not what
 * a mail or a condition kind is. Connectors register that knowledge at mount
 * time; this module never enumerates one.
 *
 * Guards are the workbench's own, reused rather than restated: a read must come
 * from the page this server sent, a write must additionally carry
 * `x-dsh-console: 1` and a JSON content type.
 *
 * @module @free-lzj/dsh-console/rules
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `ctx.webServer` service merge these routes register on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DecisionEngine } from '@free-lzj/dsh-decision'
import { isMutationRequest, isSameOrigin, readJsonBody, respond } from '../routes.ts'
import { STATE_DIR } from '../store.ts'
import {
  RULES_CONDITION_PATH, RULES_ENABLE_PATH, RULES_MODE_PATH, RULES_PRIORITY_PATH, RULES_RUNS_PATH, RULES_STATE_PATH,
  RULES_TEST_PATH, RULES_UNDO_PATH,
} from '../paths.ts'

/**
 * The rule state's directory: `$DSH_HOME/dsh-console/rules/`.
 *
 * Beside the preferences rather than inside a plugin's own directory: the rule
 * file is the workbench's, and a connector that comes and goes must not move it.
 * @param dshHome - the harness home directory.
 * @returns absolute path of the directory holding rules.yml / runs.json / pending.json.
 */
export function rulesHome(dshHome: string): string {
  return join(dshHome, STATE_DIR, 'rules')
}

/**
 * The operations these routes need from the engine.
 *
 * `Pick` rather than the class: a route spec drives a fake, and the engine's
 * other verbs (start/stop/use) are not HTTP's business.
 */
export type RulesEngine = Pick<
  DecisionEngine,
  'view' | 'setEnabled' | 'setMode' | 'setConditionValues' | 'movePriority' | 'listRuns' | 'undo' | 'test'
>

/** Everything the routes need from the plugin, injected so this module stays about HTTP. */
export interface RulesRouteHost {
  readonly engine: RulesEngine
}

/** One accepted write: run it, or say why it made no sense. */
type RulesCommand = (engine: RulesEngine) => Promise<{ readonly ok: boolean; readonly message?: string }>

/**
 * Mount the rule engine's routes.
 * @param ctx - the Host plugin context.
 * @param host - the engine they read and write.
 */
export function registerRulesRoutes(ctx: Context, host: RulesRouteHost): void {
  ctx.inject(['webServer'], (inner) => {
    const register = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      label: string,
    ): void => {
      inner.effect(() => inner.webServer.register({ kind: 'exact', path, handler }), label)
    }

    /**
     * Wrap a handler so a refusal is heard and a throw answers instead of escaping.
     * @param handler - the route body.
     * @param what - the operation named in logs and in the error answer.
     * @returns the guarded handler.
     */
    const guard = (
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
      what: string,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      return async (req, res) => {
        if (!isSameOrigin(req)) {
          respond(res, 403, { error: 'cross-origin request refused' })
          return
        }
        try {
          await handler(req, res)
        } catch (error: unknown) {
          // Never echo request data back; the page gets a stable sentence instead.
          ctx.logger.warn(`console: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          respond(res, 500, { error: `${what} failed` })
        }
      }
    }

    /**
     * One POST-only write: the page-only header, a bounded JSON body, then the command.
     * @param path - the route.
     * @param what - the log label.
     * @param read - turns the parsed body into a command, or says why it cannot.
     */
    const registerWrite = (
      path: string,
      what: string,
      read: (body: unknown) => { readonly ok: true; readonly command: RulesCommand } | { readonly ok: false; readonly error: string },
    ): void => {
      register(path, guard(async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respond(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isMutationRequest(req)) {
          respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
          return
        }
        const body = await readJsonBody(req)
        if (!body.ok) {
          respond(res, body.status, { error: body.error })
          return
        }
        const parsed = read(body.value)
        if (!parsed.ok) {
          respond(res, 400, { error: parsed.error })
          return
        }
        const result = await parsed.command(host.engine)
        // A refusal carries the reason so the page can show it next to the rule.
        respond(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.message ?? 'rejected' })
      }, what), `console.${what.replaceAll(' ', '-')}-route`)
    }

    register(RULES_STATE_PATH, guard((_req, res) => {
      respond(res, 200, host.engine.view())
    }, 'reading rule file'), 'console.rules-state-route')

    register(RULES_RUNS_PATH, guard((req, res) => {
      const since = queryOf(req).get('since')
      respond(res, 200, { runs: host.engine.listRuns(since ?? undefined) })
    }, 'reading hit records'), 'console.rules-runs-route')

    registerWrite(RULES_ENABLE_PATH, 'switching a rule', (body) => {
      const ruleId = textOf(body, 'ruleId')
      if (ruleId === undefined) return { ok: false, error: 'ruleId must not be empty' }
      const enabled = (body as Record<string, unknown>)['enabled'] === true
      return { ok: true, command: async engine => await engine.setEnabled(ruleId, enabled) }
    })

    registerWrite(RULES_MODE_PATH, 'changing an action mode', (body) => {
      const ruleId = textOf(body, 'ruleId')
      const actionIndex = intOf(body, 'actionIndex')
      const mode = textOf(body, 'mode')
      if (ruleId === undefined || actionIndex === undefined || mode === undefined) {
        return { ok: false, error: 'ruleId, actionIndex and mode are all required' }
      }
      return { ok: true, command: async engine => await engine.setMode(ruleId, actionIndex, mode) }
    })

    registerWrite(RULES_CONDITION_PATH, 'editing condition values', (body) => {
      const ruleId = textOf(body, 'ruleId')
      const conditionIndex = intOf(body, 'conditionIndex')
      const raw = (body ?? {}) as Record<string, unknown>
      const values = Array.isArray(raw['values'])
        ? raw['values'].filter((value): value is string => typeof value === 'string')
        : []
      if (ruleId === undefined || conditionIndex === undefined) {
        return { ok: false, error: 'ruleId and conditionIndex are both required' }
      }
      return { ok: true, command: async engine => await engine.setConditionValues(ruleId, conditionIndex, values) }
    })

    registerWrite(RULES_PRIORITY_PATH, 'moving a rule', (body) => {
      const ruleId = textOf(body, 'ruleId')
      const direction = textOf(body, 'direction')
      if (ruleId === undefined || (direction !== 'up' && direction !== 'down')) {
        return { ok: false, error: 'ruleId and direction (up|down) are required' }
      }
      return { ok: true, command: async engine => await engine.movePriority(ruleId, direction) }
    })

    registerWrite(RULES_UNDO_PATH, 'undoing a hit', (body) => {
      const runId = textOf(body, 'runId')
      if (runId === undefined) return { ok: false, error: 'runId must not be empty' }
      return { ok: true, command: async engine => await engine.undo(runId) }
    })

    // 试跑成功时回答的是试跑结果本身，不是 `{ ok: true }`，所以不走上面那个包装。
    register(RULES_TEST_PATH, guard(async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isMutationRequest(req)) {
        respond(res, 403, { error: 'a mutating request needs x-dsh-console: 1 and a JSON content type' })
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        respond(res, body.status, { error: body.error })
        return
      }
      const accountId = textOf(body.value, 'accountId')
      const folder = textOf(body.value, 'folder')
      const uid = intOf(body.value, 'uid')
      if (accountId === undefined || folder === undefined || uid === undefined || uid <= 0) {
        respond(res, 400, { error: 'accountId, folder and a positive uid are required' })
        return
      }
      const answer = await host.engine.test({ accountId, folder, uid })
      if (!answer.ok) {
        respond(res, 400, { error: answer.message })
        return
      }
      respond(res, 200, answer.result)
    }, 'trying the rules'), 'console.rules-test-route')
  })
}

/** One non-empty trimmed string field, or undefined. */
function textOf(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** One non-negative integer field, or undefined (a JSON number or the text a form sends). */
function intOf(body: unknown, key: string): number | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

/** Parse one request's query string without trusting the request line. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}
