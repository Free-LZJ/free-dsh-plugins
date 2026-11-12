/**
 * The mention-provider seam.
 *
 * `@` itself belongs to the harness: `dsh-client-ui-input-trigger` owns the menu
 * and `dsh-client-ui-reference` registers one source into it for files and
 * sessions. This package registers a second source for things that are neither,
 * and the provider registry below is where "things" are listed. Adding a kind of
 * thing later (an application, a plugin) means writing one provider — nothing in
 * this file or in the routes learns its name.
 *
 * @module @free-lzj/dsh-browser-use/mention
 */

import type { MentionGroup, MentionItem } from './protocol.ts'

/**
 * One source of mentionable things.
 *
 * A provider answers candidates only. It does not render, does not decide the
 * menu order beyond its own registration order, and never sees the draft — the
 * client half hands the widened menu straight to the harness.
 */
export interface MentionProvider {
  /** Stable id; also the prefix of every {@link MentionItem.ref} this provider returns. */
  readonly id: string
  /** Menu section heading, in the user's language. */
  readonly label: string
  /**
   * List candidates matching one query.
   * @param query - text after `@`, already trimmed by the caller.
   * @param signal - caller cancellation; providers must stop their own work.
   * @returns the matching items; an unreachable provider returns none rather than failing the menu.
   */
  candidates(query: string, signal: AbortSignal): Promise<readonly MentionItem[]>
}

/** What one candidate request produced, plus the failures worth logging. */
export interface CollectedMentions {
  readonly groups: readonly MentionGroup[]
  /** Providers that threw, as `id: message`; the menu is still served without them. */
  readonly failures: readonly string[]
}

/**
 * Holds every registered provider, in registration order.
 *
 * A provider that fails is dropped from the answer, the way the harness's own
 * reference source drops a domain that cannot load: the rest of the menu stays
 * usable, and one dead backend never costs the user their `@`.
 */
export class MentionRegistry {
  readonly #providers: MentionProvider[] = []

  /**
   * Add one provider.
   * @param provider - the source of one group of candidates.
   * @returns the disposer removing it; duplicate ids are refused.
   */
  register(provider: MentionProvider): () => void {
    if (this.#providers.some(existing => existing.id === provider.id)) {
      throw new Error(`mention provider "${provider.id}" is already registered`)
    }
    this.#providers.push(provider)
    return () => {
      const at = this.#providers.indexOf(provider)
      if (at >= 0) this.#providers.splice(at, 1)
    }
  }

  /** @returns the registered ids, for diagnostics. */
  ids(): readonly string[] {
    return this.#providers.map(provider => provider.id)
  }

  /**
   * Collect every provider's answer for one query.
   * @param query - text after `@`.
   * @param signal - caller cancellation.
   * @returns the non-empty groups, plus one line per provider that failed.
   */
  async collect(query: string, signal: AbortSignal): Promise<CollectedMentions> {
    const settled = await Promise.all(this.#providers.map(async provider => {
      try {
        return { provider, items: await provider.candidates(query, signal), failure: undefined }
      } catch (error: unknown) {
        // A provider that cannot answer is a missing section, not a failed menu.
        // Providers translate their own failures: the registry knows nothing
        // about what a tab or a `bsk` daemon is.
        return { provider, items: [] as readonly MentionItem[], failure: `${provider.id}: ${messageOf(error)}` }
      }
    }))
    if (signal.aborted) return { groups: [], failures: [] }
    const groups: MentionGroup[] = []
    const failures: string[] = []
    for (const entry of settled) {
      if (entry.failure !== undefined) failures.push(entry.failure)
      if (entry.items.length === 0) continue
      groups.push({ id: entry.provider.id, label: entry.provider.label, items: entry.items })
    }
    return { groups, failures }
  }
}

/**
 * The sentence an `unknown` failure carries.
 * @param error - whatever was thrown.
 * @returns its message, or the value's own text.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
