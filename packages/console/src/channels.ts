/**
 * The notification contracts: what a delivery channel is, and the registry that
 * composes them.
 *
 * Strategy: `NotificationChannel` is the family (`plan` decides whether this
 * channel wants a notice, `deliver` carries it), and each implementation — the
 * desktop notification, the in-app centre, the sound — is one concrete strategy.
 * Registry: `ChannelRegistry` is the only place that knows the set; a later
 * channel is added by registering it, not by editing the dispatcher.
 *
 * Nothing here knows which channels the user switched on: the dispatcher in
 * `console-host.ts` reads that from the configuration. That keeps the two axes
 * apart — *which* strategies exist versus *which* of them run.
 *
 * @module @free-lzj/dsh-console/channels
 */

import type { ConsoleNoticeRecord, NoticeTone } from './protocol.ts'

/** One delivered notice as a channel receives it. */
export interface NoticeDelivery {
  /** Identity and instant the workbench gave the notice. */
  readonly id: string
  readonly title: string
  readonly body?: string
  readonly tone: NoticeTone
  readonly source?: string
  readonly createdAt: number
}

/**
 * One way of telling the user.
 *
 * Deliberately narrow: a channel cannot invent notices (the workbench creates
 * the identity), cannot pick another channel, and cannot block the caller — the
 * dispatcher awaits `deliver`, so a slow channel delays only itself.
 */
export interface NotificationChannel {
  /** Stable id: what the configuration selects and the settings row lists. */
  readonly id: string
  /**
   * Whether this channel wants the notice right now.
   * @param delivery - the notice about to be delivered.
   * @returns true to deliver; false to skip it for this channel alone.
   */
  plan(delivery: NoticeDelivery): boolean
  /**
   * Carry the notice.
   * @param delivery - the notice.
   * @returns whether it was delivered (false is reported, never thrown onward).
   */
  deliver(delivery: NoticeDelivery): Promise<boolean>
}

/**
 * The composed set of channels, keyed by id.
 *
 * Registration order is the order the settings row lists them in. Delivery
 * follows the *saved selection*, not this order: the dispatcher walks the
 * configured ids, so what the user picked decides both which channels run and
 * in what sequence they are offered a notice.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, NotificationChannel>()

  /**
   * Add one channel.
   * @param channel - the implementation.
   * @returns the disposer that removes it (a duplicate id throws instead, because
   * two strategies answering one id would make the configuration ambiguous).
   */
  register(channel: NotificationChannel): () => void {
    if (this.channels.has(channel.id)) {
      throw new Error(`console: notification channel "${channel.id}" is already registered`)
    }
    this.channels.set(channel.id, channel)
    return () => {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    }
  }

  /** @returns the channel with this id, if it is registered. */
  get(id: string): NotificationChannel | undefined {
    return this.channels.get(id)
  }

  /** @returns every registered channel, in registration order. */
  list(): readonly NotificationChannel[] {
    return [...this.channels.values()]
  }
}

/** What one dispatch produced. */
export interface DispatchResult {
  /** The stored record (identity, instant, delivered channels). */
  readonly record: ConsoleNoticeRecord
  /** Channel ids that delivered, in dispatch order. */
  readonly delivered: readonly string[]
}
