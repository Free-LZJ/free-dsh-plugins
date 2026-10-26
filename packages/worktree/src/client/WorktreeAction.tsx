/**
 * The New Session control that starts a session inside a fresh worktree.
 *
 * It hangs in the Hero row of a blank session, which is exactly the moment the
 * question "should this be a separate checkout?" is still open. The trigger is
 * the shared `Button`; the dialog is the shared `Modal` around one `Input`, so
 * keyboard focus, Esc and the returning focus are the shell's own behaviour.
 *
 * Everything the control needs about its target comes from the workspace the
 * blank session already belongs to: the repository is that directory's
 * repository, so a worktree is never branched from a repository the user did
 * not open a session in.
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
import { WORKTREE_PARENT } from '../protocol.ts'
import { NS } from './locales.ts'
import { CLS } from './styles.ts'

/** What the registration hands the component: Host calls, never transport details. */
export interface WorktreeActionInjected {
  /** Create the worktree on the Host; resolves its checkout path. */
  createWorktree: (dir: string, name?: string) => Promise<{ path: string; branch: string }>
  /** Register the checkout as a Workspace; resolves the Workspace id. */
  registerWorkspace: (path: string) => Promise<string>
  /** Open (or reuse) the blank Session in that Workspace. */
  openWorkspace: (workspaceId: string) => Promise<void>
}

/** Full props of the Hero worktree control. */
export type WorktreeActionProps =
  PropsRuntime<'conversation.hero.options'>
  & PropsLocale<typeof NS>
  & InjectFace<WorktreeActionInjected>

/**
 * Render the trigger and its dialog.
 * @param props - runtime slot currency, the Host calls, and the translator.
 * @returns the control, or null while the session has no workspace directory.
 */
export function WorktreeAction({
  sessionId, useWorkspaces, createWorktree, registerWorkspace, openWorkspace, t,
}: WorktreeActionProps) {
  const dir = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // A blank session in no registry Workspace has no repository to branch from;
  // the Hero's own picker is the way forward, so this control stays out of it.
  if (dir === undefined) return null

  const close = (): void => {
    if (busy) return
    setOpen(false)
    setError(undefined)
  }

  const submit = (): void => {
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
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconBranchOutlineRegular />}
        aria-label={t('trigger')}
        title={t('trigger')}
        onClick={() => {
          setError(undefined)
          setOpen(true)
        }}
      >
        {t('trigger')}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={t('title')}
        closeLabel={t('cancel')}
        description={t('description')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={submit}>
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
                submit()
              }
            }}
          />
          <p className={CLS.hint}>{t('location', { path: `${dir}\\${WORKTREE_PARENT}\\${name.trim() || '…'}` })}</p>
          {error !== undefined ? <p className={CLS.hint} role="alert">{error}</p> : null}
          {error !== undefined ? null : busy ? <p className={CLS.hint} role="status">{t('busy')}</p> : null}
        </div>
      </Modal>
    </>
  )
}
