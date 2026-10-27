/**
 * The notify action, in the kernel.
 *
 * It is the first action to move out of a connector because it is the one that only
 * needs **values**: a title template, a tone, and a place to say it. Nothing here
 * knows what a mail is — the connector supplies the projection (see §10.5) and a
 * console port, which is exactly the shape every other action will take as it moves.
 *
 * Two behaviours are carried over deliberately from the mail version, because they
 * are the ones a user notices:
 *
 * - **A missing console is not an error.** A deployment without the workbench is a
 *   normal deployment; the action succeeds and records what it would have said.
 * - **`raise` is the fallback.** A console that offers only the item interface still
 *   gets the notification; a console that offers neither is treated as absent.
 *
 * @module @free-lzj/dsh-decision/actions/notify
 */

import { fillTemplate, type TemplateValues } from '../registry.ts'

/** A notice the console can show. */
export interface NotifyPort {
  notify?(notice: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
  }): Promise<unknown>
  raise?(item: {
    readonly title: string
    readonly body?: string
    readonly tone?: 'info' | 'success' | 'warn' | 'error'
    readonly source?: string
    readonly kind: string
    readonly actions: readonly { readonly id: string; readonly label: string }[]
  }): Promise<unknown>
}

/** What one notify call needs. */
export interface NotifyContext {
  /** The connector's projection; `{subject}`, `{from}`, `{rule}`, … */
  readonly templateValues: TemplateValues
  /** Where the notice goes, when this deployment has a workbench. */
  readonly console?: NotifyPort
  /** The connector id, so the notice says who raised it. */
  readonly source: string
  /** One line for the log when nothing can be shown. */
  readonly log: (line: string) => void
}

/** One notify action's configuration. */
export interface NotifySpec {
  readonly title?: string
  readonly body?: string
  readonly tone?: 'info' | 'success' | 'warn' | 'error'
}

/** The outcome shape every action answers with. */
export type NotifyOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly message: string }

/** The title a notice falls back to when the rule names none. */
export const DEFAULT_NOTIFY_TITLE = '{rule}: {subject}'

/**
 * Render one notice title.
 *
 * An empty render falls back to the subject alone: a blank title is a notification
 * nobody can act on, and it is the one mistake a template invites.
 * @param spec - the action's configuration.
 * @param context - the projection.
 * @returns the title to show.
 */
export function renderNotifyTitle(spec: NotifySpec, context: NotifyContext): string {
  const filled = fillTemplate(spec.title ?? DEFAULT_NOTIFY_TITLE, context.templateValues).trim()
  return filled === '' ? context.templateValues['subject'] ?? '' : filled
}

/**
 * Run the notify action.
 * @param spec - the action's configuration.
 * @param context - the projection and the console port.
 * @returns whether a human was told, with what.
 */
export async function runNotify(spec: NotifySpec, context: NotifyContext): Promise<NotifyOutcome> {
  const title = renderNotifyTitle(spec, context)
  const console_ = context.console
  const body = fillTemplate(spec.body ?? '{from} · {rule}', context.templateValues)
  if (console_?.notify === undefined && console_?.raise === undefined) {
    context.log(`[${context.source}] 未安装工作台，通知未送出：${title}`)
    return { ok: true, detail: `未安装工作台，通知未送出：${title}` }
  }
  try {
    if (console_.notify !== undefined) {
      await console_.notify({ title, body, tone: spec.tone ?? 'info', source: context.source })
    } else if (console_.raise !== undefined) {
      await console_.raise({
        title,
        body,
        tone: spec.tone ?? 'info',
        source: context.source,
        kind: context.source,
        actions: [],
      })
    }
  } catch (error: unknown) {
    return { ok: false, message: `推送通知失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, detail: `已通知：${title}` }
}
