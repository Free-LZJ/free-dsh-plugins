/**
 * The panel seat: one same-origin document, sandboxed from the shell's own
 * React tree.
 *
 * The inbox is a document rather than a component tree — a folder rail, a
 * message list, a reading pane, a settings drawer, and a nested sandboxed frame
 * for untrusted message HTML — so the Host half serves that document and this
 * half only gives it a seat and a frame. Keeping it in an iframe also keeps the
 * rendered message HTML off the shell's document entirely.
 *
 * This component owns nothing that outlives it: the `main` slot is keyed and
 * unloads on every panel switch, so the polling timer lives inside the framed
 * document and dies with the frame.
 *
 * @module @free-lzj/dsh-mail/client/MailPanel
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Route the Host half serves the panel document on. */
const PANEL_SRC = '/dsh-mail/panel'

/** Root-scoped main-panel props this frame reads. */
export type MailPanelProps = PropsRuntime<'main'> & PropsLocale<'panel.mail'>

/**
 * Fill the main panel with the Host's mail document.
 *
 * The frame is a full-height flex row so the document owns its own scrolling:
 * `min-height: 100vh` keeps it from collapsing inside a seat that states no
 * height of its own.
 * @param props - framework props; `t` names the frame for assistive technology.
 * @returns the framed panel document.
 */
export function MailPanel({ t }: MailPanelProps): ReactNode {
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: '100vh', minWidth: 0 }}>
      <iframe
        src={PANEL_SRC}
        title={t('title')}
        style={{ flex: 1, width: '100%', border: 0, display: 'block', background: 'transparent' }}
      />
    </div>
  )
}
