/**
 * Decorative occupant for the mail sidebar entry.
 *
 * Hand-drawn rather than imported, deliberately: the shell's icon set
 * (`@deepseek-ai/dsh-client-ui-primitives`) ships no mail, envelope, inbox or
 * letter glyph. The nearest name is `IconDeliverDocRegular`, and it draws a
 * sheet of paper being handed over — next to the directory guide's folder that
 * reads as "file", which is exactly the wrong affordance for the one entry that
 * means "your inbox". A dozen lines of inline SVG cost less than that
 * confusion, and adding an icon dependency for one glyph costs more than both.
 *
 * The sidebar owns the accessible label, so the glyph stays `aria-hidden`.
 *
 * @module @free-lzj/dsh-mail/client/MailIcon
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render an envelope at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative envelope icon.
 */
export function MailIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.7 7.2 11 12.3a2 2 0 0 0 2.3 0l7.3-5.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
