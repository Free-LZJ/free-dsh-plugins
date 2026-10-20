/**
 * The page-side half of a Host notice: raise it, chime it, record it.
 *
 * The Host decides *which* channels run; the page performs the two only a page
 * can — a Windows notification and a sound — and already receives the event
 * that is the in-app centre. Keeping that split in one module is what lets the
 * channel implementations stay about policy rather than about APIs.
 *
 * @module @free-lzj/dsh-console/client/surfaces
 */

import type { NoticeTone } from '../protocol.ts'

/** What a page can do about a notice. */
export interface PageFace {
  /**
   * Raise a desktop notification.
   * @param notice - title, body and tone.
   * @returns whether the page honoured it.
   */
  raise(notice: { readonly title: string; readonly body?: string; readonly tone?: NoticeTone }): Promise<boolean>
  /**
   * Play one short tone.
   * @param tone - which family of tone; errors get the lowest one.
   * @returns whether the page could play it.
   */
  chime(tone?: NoticeTone): boolean
}

/** The granularity of the tone table: how many notes a tone family gets. */
const TONES: Readonly<Record<NoticeTone, readonly number[]>> = {
  info: [660],
  success: [660, 880],
  warn: [520, 520],
  error: [440, 330],
}

/**
 * Build the page face over the real browser APIs, tolerating their absence.
 *
 * `Notification` is the Web Notification API the desktop shell surfaces through
 * the OS; `AudioContext` is created lazily on first use because a context
 * created before any gesture is refused by autoplay policy.
 * @param win - the window-like object (injected so specs need no jsdom globals).
 * @returns the page face.
 */
export function createPageFace(win: Window = window): PageFace {
  let context: AudioContext | undefined
  return {
    async raise(notice) {
      const NotificationApi = (win as unknown as { Notification?: typeof Notification }).Notification
      if (NotificationApi === undefined) return false
      if (NotificationApi.permission === 'default') {
        try {
          await NotificationApi.requestPermission()
        } catch {
          return false
        }
      }
      if (NotificationApi.permission !== 'granted') return false
      try {
        const shown = new NotificationApi(notice.title, {
          body: notice.body ?? '',
          tag: `dsh-console-${notice.title}`,
          silent: true,
        })
        shown.onclick = () => {
          win.focus()
          shown.close()
        }
        return true
      } catch {
        return false
      }
    },
    chime(tone = 'info') {
      const AudioCtor = (win as unknown as { AudioContext?: typeof AudioContext }).AudioContext
      if (AudioCtor === undefined) return false
      try {
        context ??= new AudioCtor()
        const notes = TONES[tone] ?? TONES.info
        const start = context.currentTime
        notes.forEach((frequency, index) => {
          const oscillator = context!.createOscillator()
          const gain = context!.createGain()
          const at = start + index * 0.12
          oscillator.frequency.value = frequency
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(0.08, at + 0.01)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1)
          oscillator.connect(gain).connect(context!.destination)
          oscillator.start(at)
          oscillator.stop(at + 0.12)
        })
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Describe why desktop notifications cannot appear, if they cannot.
 * @param win - the window-like object.
 * @returns a reason, or undefined when desktop notifications are usable.
 */
export function desktopBlockedReason(win: Window = window): 'unavailable' | 'denied' | undefined {
  const NotificationApi = (win as unknown as { Notification?: typeof Notification }).Notification
  if (NotificationApi === undefined) return 'unavailable'
  return NotificationApi.permission === 'denied' ? 'denied' : undefined
}
