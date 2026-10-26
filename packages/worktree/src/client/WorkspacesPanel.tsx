/**
 * The Workspaces page: every Workspace DSH has registered, and the one action a
 * registration supports.
 *
 * Removing a registration is not a file operation. DSH keeps Workspaces as an
 * ordered registry: dropping one leaves the folder, the files and every Session
 * log exactly where they are, and the Sessions that were accounted to it become
 * ungrouped. The page says so once, in the header, instead of repeating the
 * warning per row.
 *
 * @module @free-dsh/worktree/client/WorkspacesPanel
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WORKTREE_PARENT } from '../protocol.ts'
import { NS } from './locales.ts'
import { CLS } from './styles.ts'

/** How long an armed removal waits for its confirming press before disarming. */
const CONFIRM_MS = 3_000

/** What the registration hands the panel. */
export interface WorkspacesPanelInjected {
  /** Drop one registration (never a file). */
  remove: (workspaceId: string) => Promise<void>
}

/** Full props of the Workspaces page. */
export type WorkspacesPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & InjectFace<WorkspacesPanelInjected>

/**
 * Render the registry as a list of removable rows.
 * @param props - panel currency, the removal call, and the translator.
 * @returns the page.
 */
export function WorkspacesPanel({ useWorkspaces, remove, t }: WorkspacesPanelProps) {
  const snapshot = useWorkspaces(state => state)
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // An armed row disarms on its own, so a first press never becomes a delete
  // waiting for a stray second one.
  useEffect(() => {
    if (armed === undefined) return
    const timer = setTimeout(() => { setArmed(undefined) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [armed])

  const press = (workspaceId: string): void => {
    if (busy) return
    if (armed !== workspaceId) {
      setArmed(workspaceId)
      return
    }
    setBusy(true)
    setArmed(undefined)
    setError(undefined)
    void remove(workspaceId)
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const items = snapshot.items
  const worktreeMarker = WORKTREE_PARENT.split('/').join('\\')

  return (
    <div className={CLS.panel}>
      <header className={CLS.panelHeader}>
        <h1 className={CLS.panelTitle}>{t('panelTitle')}</h1>
        <span className={CLS.hint}>{t('listed', { count: items.length })}</span>
      </header>
      <div className={CLS.panelBody}>
        <p className={CLS.hint}>{t('panelHint')}</p>
        {snapshot.phase !== 'ready'
          ? <p className={CLS.hint} role="status">{t('panelLoading')}</p>
          : items.length === 0
            ? <p className={CLS.hint}>{t('panelEmpty')}</p>
            : (
              <ul className={CLS.list}>
                {items.map(workspace => (
                  <li key={workspace.workspaceId} className={CLS.row}>
                    <span className={CLS.rowText}>
                      <span className={CLS.rowTitle} title={workspace.path}>
                        {workspace.title}
                        {workspace.path.toLowerCase().includes(worktreeMarker.toLowerCase())
                          ? <span className={CLS.tag}> {t('workspaceWorktree')}</span>
                          : null}
                      </span>
                      <span className={CLS.rowMeta}>
                        {workspace.path}
                        {' · '}
                        {t('workspaceSessions', { count: workspace.sessionIds.length })}
                      </span>
                    </span>
                    <span className={CLS.rowActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => { press(workspace.workspaceId) }}
                      >
                        {armed === workspace.workspaceId ? t('confirmRemoval') : t('removeRegistration')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
        {error !== undefined ? <p className={CLS.error} role="alert">{error}</p> : null}
      </div>
    </div>
  )
}
