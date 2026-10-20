/**
 * Decorative occupant for the mail sidebar entry, and the glyph on mail's card
 * in the workbench's home list.
 *
 * Hand-drawn rather than imported, deliberately: the shell's icon set
 * (`@deepseek-ai/dsh-client-ui-primitives`) ships no mail, envelope, inbox or
 * letter glyph. The nearest name is `IconDeliverDocRegular`, and it draws a
 * sheet of paper being handed over, which reads as "file" — the wrong
 * affordance for the one entry that means "your inbox". A dozen lines of inline
 * SVG cost less than that confusion, and adding an icon dependency for one
 * glyph costs more than both.
 *
 * The sidebar owns the accessible label, so the glyph stays `aria-hidden`. The
 * props are narrowed to the one fact the drawing reads, so the workbench can
 * render the same glyph on a card without the sidebar's whole standard seat.
 *
 * @module @free-lzj/dsh-mail/client/MailIcon
 */

/**
 * Render an envelope at the size the host asks for.
 * @param props - the requested edge in pixels.
 * @returns decorative envelope icon.
 */
export function MailIcon({ size }: { readonly size: number }) {
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
