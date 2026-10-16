/**
 * The panel seat: one same-origin document, sandboxed from the shell's own
 * React tree.
 *
 * The listing is a document rather than a component tree — three layouts over
 * one tree, reorderable columns, and a preview dialog — so the Host half serves
 * that document and this half only gives it a seat and a frame. Keeping it in
 * an iframe also keeps its styles and its `dialog` element off the shell.
 *
 * @module @free-lzj/dsh-directory-guide/client/GuidePanel
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Route the Host half serves the panel document on. */
const PANEL_SRC = '/dsh-directory-guide/panel'

/** Root-scoped main-panel props this frame reads. */
export type GuidePanelProps = PropsRuntime<'main'> & PropsLocale<'panel.directoryGuide'>

/**
 * Fill the main panel with the Host's directory-guide document.
 *
 * The frame is a full-height flex row so the document owns its own scrolling:
 * `min-height: 100vh` keeps it from collapsing inside a seat that states no
 * height of its own.
 * @param props - framework props; `t` names the frame for assistive technology.
 * @returns the framed panel document.
 */
export function GuidePanel({ t }: GuidePanelProps): ReactNode {
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
