/**
 * The New Session control that starts a session inside a fresh worktree.
 *
 * It hangs in the Session title bar (always there) and in the New Session row
 * (the moment the question is still open). One action: create a checkout in the
 * current Session's repository and continue in it. Everything that *manages*
 * checkouts — the settings, the per-repository lists, removal — lives on the
 * Worktrees page, which this dialog links to.
 *
 * @module @free-lzj/dsh-worktree/client/WorktreeAction
 */

import { useState } from 'react'
import {
  Button, IconBranchOutlineRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { WorktreeSettings } from '../protocol.ts'
import { WORKTREE_PARENT } from '../protocol.ts'
import { NS } from './locales.ts'
import { CLS } from './styles.ts'

/** What the registration hands the component: Host calls, never transport details. */
export interface WorktreeActionInjected {
  /** Create the worktree on the Host; resolves its checkout path. */
  createWorktree: (dir: string, name?: string) => Promise<{ path: string; branch: string; base: string; warning?: string }>
  /** Register the checkout as a Workspace; resolves the Workspace id. */
  registerWorkspace: (path: string) => Promise<string>
  /** Open (or reuse) the blank Session in that Workspace. */
  openWorkspace: (workspaceId: string) => Promise<void>
  /** Switch the main panel to the Worktrees page. */
  openManager: () => void
  /** Read the settings, so the dialog can announce where the checkout will land. */
  settings: () => Promise<WorktreeSettings>
}

/** Full props of the worktree control. */
export type WorktreeActionProps =
  PropsRuntime<'conversation.hero.options'>
  & PropsLocale<typeof NS>
  & InjectFace<WorktreeActionInjected>

/**
 * Render the trigger and its create dialog.
 * @param props - runtime slot currency, the Host calls, and the translator.
 * @returns the control, or null while the session has no workspace directory.
 */
export function WorktreeAction({
  sessionId, useWorkspaces, createWorktree, registerWorkspace, openWorkspace, openManager, settings, t,
}: WorktreeActionProps) {
  const dir = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [parent, setParent] = useState<string | undefined>(undefined)

  // A blank session in no registry Workspace has no repository to branch from;
  // the Hero's own picker is the way forward, so this control stays out of it.
  if (dir === undefined) return null

  const close = (): void => {
    if (busy) return
    setOpen(false)
    setError(undefined)
  }

  const reveal = (): void => {
    setError(undefined)
    setOpen(true)
    // The configured directory decides the path this dialog announces; reading
    // it on open keeps the dialog honest after a settings change elsewhere.
    void settings()
      .then(current => setParent(current.parent))
      .catch(() => setParent(undefined))
  }

  const create = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    const requested = name.trim()
    void createWorktree(dir, requested === '' ? undefined : requested)
      .then(result => registerWorkspace(result.path))
      .then(workspaceId => openWorkspace(workspaceId))
      .then(() => {
        setOpen(false)
        setName('')
      })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const repoTail = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const target = parent === undefined || parent === ''
    ? `${dir}\\${WORKTREE_PARENT}`
    : `${parent}\\${repoTail}`

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconBranchOutlineRegular />}
        aria-label={t('trigger')}
        title={t('trigger')}
        onClick={reveal}
      >
        {t('trigger')}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={t('createTitle')}
        closeLabel={t('cancel')}
        description={t('createDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setOpen(false); openManager() }}>
              {t('manage')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={create}>
              {busy ? t('busy') : t('create')}
            </Button>
          </>
        )}
      >
        <div className={CLS.field}>
          <label className={CLS.label} htmlFor="dshw-name">{t('nameLabel')}</label>
          <Input
            id="dshw-name"
            value={name}
            maxLength={64}
            placeholder={t('namePlaceholder')}
            aria-label={t('nameLabel')}
            data-modal-autofocus=""
            disabled={busy}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                create()
              }
            }}
          />
          <p className={CLS.hint}>{t('location', { path: `${target}\\${name.trim() || '…'}` })}</p>
          {error !== undefined ? <p className={CLS.error} role="alert">{error}</p> : null}
        </div>
      </Modal>
    </>
  )
}
