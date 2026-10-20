/**
 * The notification settings row.
 *
 * Built exactly like the shipped General-section rows (`EnterBehaviorRow` is the
 * model): title 14/22, description 12/18 tertiary, `16px 0` padding and a 0.5px
 * `--dsw-alias-border-l2` rule. The control is the shared `Menu` in its
 * multi-select form — `selectedIds` plus a selection mark — so picking channels
 * needs no hand-built dropdown (see `rules/plugin-ui.md`).
 *
 * The row is a *view* of two facts the Host owns: which channels exist
 * (`availableChannels`) and which are switched on. That is why a fourth channel
 * needs no change here: it appears as a row the moment it is registered.
 *
 * @module @free-lzj/dsh-console/client/settings-row
 */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelInfo } from '../protocol.ts'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

/** What the row writes and where its state comes from. */
export interface SettingsRowInjected {
  /** Subscribe to the Host snapshot's channel list. */
  readonly useChannels: () => readonly ChannelInfo[]
  /** Replace the enabled set; resolves to whether the Host accepted it. */
  readonly saveChannels: (channels: readonly string[]) => Promise<boolean>
  /** Subscribe to whether the page may raise desktop notifications. */
  readonly useDesktopBlocked: () => 'unavailable' | 'denied' | undefined
}

/**
 * Props of the settings row.
 *
 * What the row reads, not the framework's whole composed seat: the slot passes
 * no owner props at all, and a component taking a subset is assignable where a
 * component taking all of them is expected.
 */
export type ConsoleSettingsRowProps = { readonly t: Translate } & SettingsRowInjected

/**
 * Draw the row.
 *
 * A staged set starts from what is saved and each accepted write settles it; a
 * refused one reports itself and leaves the draft alone so the user can retry
 * without re-picking.
 * @param props - the framework seat plus the injected face.
 * @returns the row.
 */
export function ConsoleSettingsRow({ t, useChannels, saveChannels, useDesktopBlocked }: ConsoleSettingsRowProps): ReactNode {
  const channels = useChannels()
  const blocked = useDesktopBlocked()
  const saved = channels.filter((channel) => channel.enabled).map((channel) => channel.id)
  const [staged, setStaged] = useState<readonly string[]>(saved)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle')

  const nameOf = (id: string): string => channelLabel(t, id).title
  const summary = channels.filter((channel) => staged.includes(channel.id)).map((channel) => nameOf(channel.id))

  return (
    <div className={CLS.row}>
      <div className={CLS.rowText}>
        <div className={CLS.rowTitle}>{t('settingsTitle')}</div>
        <div className={CLS.rowDesc}>{settingsHint(t, blocked, status)}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        align="end"
        portal
        autoFocus
        selectedIds={staged}
        items={channels.map((channel) => ({ id: channel.id, label: nameOf(channel.id) }))}
        onSelect={(id) => {
          const next = staged.includes(id) ? staged.filter((entry) => entry !== id) : [...staged, id]
          // At least one channel stays on: a workbench that tells nobody is a bug
          // the user would only notice the day a notice went missing.
          if (next.length === 0) return
          setStaged(next)
          setStatus('idle')
          void saveChannels(next).then((ok) => { setStatus(ok ? 'saved' : 'failed') })
        }}
        anchor={(
          <button
            type="button"
            className={CLS.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('settingsTitle')}
            onClick={() => { setOpen((value) => !value) }}
          >
            {summary.length === 0 ? t('settingsLocked') : summary.join('、')}
            <IconChevronDownOutlineRegular className={CLS.chevron} />
          </button>
        )}
      />
    </div>
  )
}

/**
 * The row's supporting sentence: what the choice means, plus whatever the page
 * knows about the current selection.
 * @param t - the workbench translate seat.
 * @param blocked - why desktop notifications cannot reach the user, if they cannot.
 * @param status - the last write's outcome.
 * @returns the description line.
 */
function settingsHint(t: Translate, blocked: 'unavailable' | 'denied' | undefined, status: 'idle' | 'saved' | 'failed'): string {
  const parts = [t('settingsHint')]
  if (blocked === 'denied') parts.push(t('noticePermissionDenied'))
  else if (blocked === 'unavailable') parts.push(t('noticeUnavailable'))
  if (status === 'saved') parts.push(t('settingsSaved'))
  else if (status === 'failed') parts.push(t('settingsFailed'))
  return parts.join(' ')
}

/**
 * Localized name and explanation for one channel id.
 * @param t - the workbench translate seat.
 * @param id - the channel id.
 * @returns the label; an unknown id falls back to itself.
 */
export function channelLabel(t: Translate, id: string): { title: string; hint: string } {
  if (id === 'desktop') return { title: t('channelDesktop'), hint: t('channelDesktopHint') }
  if (id === 'inapp') return { title: t('channelInapp'), hint: t('channelInappHint') }
  if (id === 'sound') return { title: t('channelSound'), hint: t('channelSoundHint') }
  return { title: id, hint: '' }
}
