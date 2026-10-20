/**
 * The three channels this package ships, plus the wiring that turns the
 * browser's event stream into what a channel can actually do.
 *
 * The workbench has no privileged route from the Host to the user's screen:
 * the desktop notification is raised by the page (only a page holds the
 * `Notification` permission), the sound is played by the page, and the in-app
 * centre *is* the page's state. So every browser-backed channel here is a
 * **presence gate**: it wants a notice only while at least one page is
 * streaming events, and its `deliver` is satisfied by that same stream.
 * When no page is open, `plan()` answers false, and a channel registered by an
 * outermost deployment (a webhook, an MQ bridge) is the one that still works.
 *
 * @module @free-lzj/dsh-console/builtin-channels
 */

import type { ChannelRegistry, NotificationChannel, NoticeDelivery } from './channels.ts'
import type { ConsoleLayout } from './protocol.ts'

/**
 * Tracks the workbenches currently streaming events.
 *
 * Every channel that needs a page consults it; nothing else needs to know how
 * many there are.
 */
export class PresenceGate {
  private readers = 0

  /** Register one open event stream. @returns the disposer. */
  open(): () => void {
    this.readers += 1
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.readers -= 1
    }
  }

  /** @returns whether any page is currently streaming. */
  get live(): boolean {
    return this.readers > 0
  }
}

/** The view layouts the settings document accepts. */
export const LAYOUTS: readonly ConsoleLayout[] = ['grid', 'list', 'compact']

/**
 * The page's own notification APIs, injected so specs never need a browser.
 *
 * `raise` is the desktop notification, `chime` the sound; both answer whether
 * the page could honour them. A deployment without either (a headless Host)
 * simply gets `false` and the channel reports the notice undelivered there.
 */
export interface PageSurfaces {
  raise: (delivery: NoticeDelivery) => Promise<boolean>
  chime: (delivery: NoticeDelivery) => boolean
}

/** What each channel needs to decide and to deliver. */
export type BuiltinChannelWiring = {
  readonly gate: PresenceGate
  readonly pages: PageSurfaces
}

/**
 * Register the package's own channels.
 * @param registry - the channel set to fill.
 * @param wiring - presence gate and page surfaces.
 */
export function registerBuiltinChannels(registry: ChannelRegistry, wiring: BuiltinChannelWiring): void {
  registry.register(desktopChannel(wiring))
  registry.register(inappChannel(wiring))
  registry.register(soundChannel(wiring))
}

/**
 * A Windows desktop notification, raised by the page: this is the default way a
 * notice reaches someone who is looking at another window.
 * @param wiring - presence gate and page surfaces.
 * @returns the channel.
 */
export function desktopChannel({ gate, pages }: BuiltinChannelWiring): NotificationChannel {
  return {
    id: 'desktop',
    plan: () => gate.live,
    deliver: (delivery) => pages.raise(delivery),
  }
}

/**
 * The in-app centre: the notice list and the badge. Its delivery is the event
 * the stream already carries, so a live page is the whole condition.
 * @param wiring - presence gate.
 * @returns the channel.
 */
export function inappChannel({ gate }: BuiltinChannelWiring): NotificationChannel {
  return {
    id: 'inapp',
    plan: () => gate.live,
    deliver: () => Promise.resolve(true),
  }
}

/**
 * A short tone for notices worth hearing even when the window is behind
 * another one.
 * @param wiring - presence gate and page surfaces.
 * @returns the channel.
 */
export function soundChannel({ gate, pages }: BuiltinChannelWiring): NotificationChannel {
  return {
    id: 'sound',
    plan: () => gate.live,
    deliver: (delivery) => Promise.resolve(pages.chime(delivery)),
  }
}
