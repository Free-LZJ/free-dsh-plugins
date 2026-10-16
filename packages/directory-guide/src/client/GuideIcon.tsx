/** Decorative occupant for the directory-guide sidebar entry. */
import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the open-folder glyph at the size the sidebar asks for; the sidebar
 * owns the accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative folder icon.
 */
export function GuideIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconFolderOpenOutlineRegular size={size} />
}
