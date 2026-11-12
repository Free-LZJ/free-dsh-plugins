/**
 * Mentionable things in the `@` menu — browser half.
 *
 * The harness already owns `@`: `ui-input-trigger` renders the grouped menu and
 * routes a pick to whichever source registered the row. Files and sessions come
 * from `ui-reference`; this source adds everything that is neither, and the
 * Host's provider registry decides what that is today.
 *
 * A pick inserts one atomic chip whose serialized form is the same
 * `@[label](scheme:id)` mention the harness uses for a session. That is not
 * decoration: the model reads the chip as text, so the mention has to carry the
 * id the `browser_tab` tool can act on.
 *
 * @module @free-lzj/dsh-browser-use/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  InputTriggerCandidate, InputTriggerSource, InputTriggerServiceContract, PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MENTIONS_PATH, type MentionGroup, type MentionsResult } from '../protocol.ts'
import { NS, en, zh, type BrowserUseKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** `@` menu section headings. */
    browserUse: BrowserUseKey
  }
}

/** Required services: the trigger registry and the copy. */
export const inject = ['inputTriggers', 'locale']

/** Source name. Unique within `@`, and the serializer routing key of every chip this source inserts. */
const SOURCE_NAME = 'mention'

/** Registration order against `ui-reference`; the file/session group stays first. */
const SOURCE_ORDER = 10

/**
 * The mention scheme a ref is rewritten to.
 *
 * `browser:299872133` becomes `dsh-browser:299872133` so every scheme this menu
 * produces looks alike (`dsh-session:` already does), and nothing mistakes a tab
 * id for a path.
 * @param ref - provider-qualified ref, as the Host returned it.
 * @returns the mention's own address.
 */
export function mentionAddress(ref: string): string {
  const at = ref.indexOf(':')
  if (at < 0) return `dsh-${ref}`
  return `dsh-${ref.slice(0, at)}:${ref.slice(at + 1)}`
}

/**
 * Render one row's section heading.
 * @param group - the provider's answer.
 * @param t - the namespace's translator.
 * @returns the translated heading when we have one, else the provider's own label.
 */
function sectionLabel(group: MentionGroup, t: (key: BrowserUseKey) => string): string {
  // A provider added later has no key here yet; its own label is still the
  // honest heading, so an untranslated section beats an empty one.
  return group.id === 'browser' ? t('sectionBrowser') : group.label
}

/**
 * Ask the Host what can be mentioned.
 * @param query - text after `@`.
 * @param signal - the menu's cancellation.
 * @returns every reachable group; an unreachable Host yields no rows rather than an error.
 */
async function fetchGroups(query: string, signal: AbortSignal): Promise<readonly MentionGroup[]> {
  try {
    const response = await fetch(`${MENTIONS_PATH}?q=${encodeURIComponent(query)}`, {
      signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return []
    const body = await response.json() as MentionsResult
    return Array.isArray(body.groups) ? body.groups : []
  } catch {
    // The menu stays open with the file/session group; a failed lookup is not a
    // prompt to explain itself in the middle of typing.
    return []
  }
}

/**
 * One candidate row per mentionable thing.
 * @param group - the provider's answer.
 * @param section - rendered heading.
 * @returns rows for the menu.
 */
function rowsOf(group: MentionGroup, section: string): InputTriggerCandidate[] {
  return group.items.map(item => {
    const value = JSON.stringify({ ref: item.ref, label: item.label })
    return {
      // The ref is the row's identity: it is what a pick payload carries and what
      // exact-match typing compares against.
      name: item.ref,
      label: item.label,
      ...(item.description === undefined ? {} : { description: item.description }),
      // The harness's own glyph set is file/folder/session; a window-ish row
      // reads best as a session until a dedicated icon exists.
      icon: 'session',
      section,
      value,
    } satisfies InputTriggerCandidate
  })
}

/**
 * Register the mention source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'browser-use: dictionaries')
  const t = ctx.locale.bind(NS)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract | undefined
  if (inputTriggers === undefined) {
    ctx.logger?.warn?.('browser-use: no input trigger pipeline, @ mention not registered')
    return
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE_NAME,
    order: SOURCE_ORDER,
    // Rows carry their own `section`; a source-title row on top of that would
    // repeat the heading.
    showGroupTitle: false,
    async candidates(_session, req) {
      // `@"` is an open quoted path: that query belongs to files alone.
      if (req.quoted === true) return []
      const groups = await fetchGroups(req.query, req.signal)
      if (req.signal.aborted) return []
      return groups.flatMap(group => rowsOf(group, sectionLabel(group, t)))
    },
    onPick({ candidate }): PickOutcome {
      const value = parseValue(candidate.value)
      if (value === undefined) return undefined
      const mention = `@[${value.label}](${mentionAddress(value.ref)})`
      return {
        insert: {
          source: SOURCE_NAME,
          // The ref IS the mention: `serialize` has no label to work with, so
          // carrying the whole token here is what keeps the chip readable after
          // the draft is restored.
          ref: mention,
          label: value.label,
          appearance: 'file',
          clipboardText: mention,
        },
      }
    },
    codec: {
      clipboardText: (ref: string): string => ref,
      serialize: async (ref: string, _signal: AbortSignal): Promise<string> => ref,
    },
  }

  ctx.effect(() => inputTriggers.registerSource(source), 'browser-use: @ source')
}

/**
 * Read a row's pick payload.
 * @param value - the row's opaque `value`.
 * @returns the ref and label, or undefined when the row was not ours.
 */
function parseValue(value: string | undefined): { ref: string; label: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as { ref?: unknown; label?: unknown }
    if (typeof parsed.ref !== 'string' || typeof parsed.label !== 'string') return undefined
    return { ref: parsed.ref, label: parsed.label }
  } catch {
    return undefined
  }
}
