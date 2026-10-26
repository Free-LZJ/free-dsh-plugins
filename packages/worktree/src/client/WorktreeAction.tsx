/**
 * The New Session control that starts a session inside a Git worktree, plus the
 * small manager for the checkouts that already exist.
 *
 * It hangs in the Hero row of a blank session, which is exactly the moment the
 * question "should this be a separate checkout?" is still open. The dialog is the
 * shared `Modal` around one `Input` and a list, so keyboard focus, Esc and the
 * returning focus are the shell's own behaviour.
 *
 * Everything the control needs about its target comes from the workspace the
 * blank session already belongs to: the repository is that directory's
 * repository, so a worktree is never branched from a repository the user did not
 * open a session in.
 *
 * @module @free-lzj/dsh-worktree/client/WorktreeAction
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconBranchOutlineRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ListWorktreesResult, WorktreeSummary } from '../protocol.ts'
import { WORKTREE_PARENT } from '../protocol.ts'
import { NS } from './locales.ts'
import { CLS } from './styles.ts'

/** How long an armed removal waits for its confirming press before disarming. */
const CONFIRM_MS = 3_000

/** What the registration hands the component: Host calls, never transport details. */
export interface WorktreeActionInjected {
  /** Create the worktree on the Host; resolves its checkout path. */
  createWorktree: (dir: string, name?: string) => Promise<{ path: string; branch: string }>
  /** Read the repository's checkouts. */
  listWorktrees: (dir: string) => Promise<ListWorktreesResult>
  /** Remove one managed checkout, and its branch, through the Host. */
  removeWorktree: (dir: string, path: string) => Promise<{ removed: string; branch?: string }>
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
 * Turn any thrown value into the sentence to show.
 * @param reason - whatever a Host call rejected with.
 * @returns its message.
 */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Render the trigger, the create field, and the list of existing checkouts.
 * @param props - runtime slot currency, the Host calls, and the translator.
 * @returns the control, or null while the session has no workspace directory.
 */
export function WorktreeAction({
  sessionId, useWorkspaces, createWorktree, listWorktrees, removeWorktree,
  registerWorkspace, openWorkspace, t,
}: WorktreeActionProps) {
  const dir = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<readonly WorktreeSummary[] | undefined>(undefined)
  const [repo, setRepo] = useState<string | undefined>(undefined)
  const [armed, setArmed] = useState<string | undefined>(undefined)

  const refresh = useCallback((): void => {
    if (dir === undefined) return
    setEntries(undefined)
    void listWorktrees(dir)
      .then((result) => {
        setRepo(result.repo)
        setEntries(result.worktrees)
      })
      .catch((reason: unknown) => {
        setEntries([])
        setError(messageOf(reason))
      })
  }, [dir, listWorktrees])

  // The list is read when the dialog opens, not while it is closed: a checkout
  // created by another session only needs to appear the next time it matters.
  useEffect(() => {
    if (!open) return
    setError(undefined)
    refresh()
  }, [open, refresh])

  // An armed removal disarms on its own, so a first press never becomes a
  // delete waiting for a stray second one.
  useEffect(() => {
    if (armed === undefined) return
    const timer = setTimeout(() => { setArmed(undefined) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [armed])

  // A blank session in no registry Workspace has no repository to branch from;
  // the Hero's own picker is the way forward, so this control stays out of it.
  if (dir === undefined) return null

  const close = (): void => {
    if (busy) return
    setOpen(false)
    setArmed(undefined)
    setError(undefined)
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
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(false) })
  }

  const enter = (path: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void registerWorkspace(path)
      .then(workspaceId => openWorkspace(workspaceId))
      .then(() => { setOpen(false) })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(false) })
  }

  const remove = (path: string): void => {
    if (busy) return
    if (armed !== path) {
      setArmed(path)
      return
    }
    setBusy(true)
    setArmed(undefined)
    setError(undefined)
    void removeWorktree(dir, path)
      .then(() => { refresh() })
      .catch((reason: unknown) => {
        // Removal can half-succeed: the checkout is gone and the branch stayed.
        // The Host's sentence says which, so show it and refresh anyway.
        setError(messageOf(reason))
        refresh()
      })
      .finally(() => { setBusy(false) })
  }

  const row = (entry: WorktreeSummary) => (
    <li key={entry.path} className={CLS.row}>
      <span className={CLS.rowText}>
        <span className={CLS.rowTitle} title={entry.path}>
          {entry.branch ?? t('branchless')}
        </span>
        <span className={CLS.rowMeta}>
          {entry.main
            ? `${t('mainCheckout')} · ${entry.head.slice(0, 8)}`
            : `${entry.path.slice(repo === undefined ? 0 : repo.length + 1)} · ${entry.head.slice(0, 8)}`}
          {entry.main || entry.managed ? '' : ` · ${t('external')}`}
        </span>
      </span>
      <span className={CLS.rowActions}>
        {entry.main ? null : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { enter(entry.path) }}>
            {t('enter')}
          </Button>
        )}
        {entry.managed && !entry.main && !entry.locked
          ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { remove(entry.path) }}>
              {armed === entry.path ? t('removeConfirm') : t('remove')}
            </Button>
          )
          : null}
      </span>
    </li>
  )

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconBranchOutlineRegular />}
        aria-label={t('trigger')}
        title={t('trigger')}
        onClick={() => { setOpen(true) }}
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
          <p className={CLS.hint}>
            {t('location', { path: `${dir}\\${WORKTREE_PARENT}\\${name.trim() || '…'}` })}
          </p>
        </div>
        <div className={CLS.section}>
          <div className={CLS.sectionTitle}>
            <span>{t('listTitle')}</span>
            <span className={CLS.hint}>
              {entries === undefined ? '' : t('listed', { count: entries.length })}
            </span>
          </div>
          {entries === undefined
            ? <p className={CLS.hint} role="status">{t('listLoading')}</p>
            : entries.length === 0
              ? <p className={CLS.hint}>{t('listEmpty')}</p>
              : <ul className={CLS.list}>{entries.map(row)}</ul>}
        </div>
        {error !== undefined ? <p className={CLS.error} role="alert">{error}</p> : null}
      </Modal>
    </>
  )
}
