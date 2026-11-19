/**
 * The Worktrees page: settings on top, then one card per repository with its
 * checkouts.
 *
 * Grouping by repository is the whole point. A worktree is a checkout *of* a
 * repository, and the question a user asks is "what checkouts does this project
 * have", not "which directory did I register". The Host assembles the groups from
 * the registered Workspaces, so the page lists exactly the projects the user
 * works in.
 *
 * Removing a checkout is destructive and Git can refuse it, so the page answers
 * the two questions a pressed button would otherwise leave open: what exactly is
 * about to go (a dialog naming the path, the branch and any uncommitted work),
 * and, when Git still says no, why — the reason stays on screen instead of being
 * cleared by the refresh that followed it.
 *
 * @module @free-lzj/dsh-worktree/client/WorktreesPanel
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RepoOverview, OverviewResult, WorktreeSettings, WorktreeSummary } from '../protocol.ts'
import { NS } from './locales.ts'
import { CLS } from './styles.ts'

/** One removal waiting for its confirmation. */
interface PendingRemoval {
  /** Repository that owns the checkout. */
  readonly repo: string
  /** The row that was pressed. */
  readonly entry: WorktreeSummary
}

/** What the registration hands the page: Host calls and navigation. */
export interface WorktreesPanelInjected {
  /** Read every repository's checkouts plus the settings. */
  overview: () => Promise<OverviewResult>
  /** Persist one settings write. */
  saveSettings: (patch: Partial<WorktreeSettings>) => Promise<WorktreeSettings>
  /** Create one checkout in a repository; resolves it. */
  createWorktree: (dir: string, name?: string) => Promise<{ path: string; branch: string; base: string; warning?: string }>
  /**
   * Remove one checkout, and its branch, through the Host.
   * @param force - discard uncommitted changes instead of letting Git refuse.
   */
  removeWorktree: (dir: string, path: string, force?: boolean) => Promise<{ removed: string; branch?: string }>
  /** Register the checkout as a Workspace; resolves the Workspace id. */
  registerWorkspace: (path: string) => Promise<string>
  /** Drop the Workspace registration that names a path, if any. */
  forgetWorkspace: (path: string) => Promise<void>
  /** Open (or reuse) the blank Session in a Workspace. */
  openWorkspace: (workspaceId: string) => Promise<void>
}

/** Full props of the Worktrees page. */
export type WorktreesPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & InjectFace<WorktreesPanelInjected>

/** The part of a path below a repository, with forward slashes on every platform. */
function below(repo: string, path: string): string {
  return path.slice(repo.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

/** Longest suffix of a path that still identifies it in one line. */
function tail(path: string, keep = 2): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '')
  return parts.slice(-keep).join('/')
}

/**
 * The sentence to show for a rejection.
 * @param reason - whatever a promise rejected with.
 * @returns its message, or the value itself.
 */
function sentence(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Render the page.
 * @param props - panel currency, the Host calls, and the translator.
 * @returns the settings card and one card per repository.
 */
export function WorktreesPanel({
  overview, saveSettings, createWorktree, removeWorktree, registerWorkspace, forgetWorkspace,
  openWorkspace, t,
}: WorktreesPanelProps) {
  const [data, setData] = useState<OverviewResult | undefined>(undefined)
  const [parent, setParent] = useState('')
  const [fetchUpstream, setFetchUpstream] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<RepoOverview | undefined>(undefined)
  const [name, setName] = useState('')
  const [pending, setPending] = useState<PendingRemoval | undefined>(undefined)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | undefined>(undefined)

  /**
   * Re-read the page.
   *
   * `keepError` exists because of the bug that made every failed removal look
   * like a no-op: the catch called this loader, whose first act was to clear the
   * error the same press had just set. The loader now clears the page error only
   * when the user asked for a refresh, not when a failure refreshes the rows.
   * @param keepError - leave the page error in place.
   */
  const load = useCallback((keepError = false): void => {
    if (!keepError) setError(undefined)
    void overview()
      .then((result) => {
        setData(result)
        setParent(result.settings.parent)
        setFetchUpstream(result.settings.fetchBeforeCreate)
      })
      .catch((reason: unknown) => {
        setData({ settings: { parent: '', fetchBeforeCreate: true }, repos: [], unresolved: [] })
        setError(sentence(reason))
      })
  }, [overview])

  // Called through a wrapper, never handed to onClick directly: a press would
  // otherwise pass its MouseEvent as `keepError`.
  useEffect(() => { load() }, [load])

  const save = (): void => {
    if (saving) return
    setSaving(true)
    setError(undefined)
    void saveSettings({ parent: parent.trim(), fetchBeforeCreate: fetchUpstream })
      .then((next) => {
        setParent(next.parent)
        setFetchUpstream(next.fetchBeforeCreate)
        setSaved(true)
        setTimeout(() => { setSaved(false) }, 2_000)
      })
      .catch((reason: unknown) => { setError(sentence(reason)) })
      .finally(() => { setSaving(false) })
  }

  const create = (): void => {
    if (target === undefined || busy) return
    setBusy(true)
    setError(undefined)
    const requested = name.trim()
    void createWorktree(target.repo, requested === '' ? undefined : requested)
      .then(result => registerWorkspace(result.path))
      .then(workspaceId => openWorkspace(workspaceId))
      .then(() => {
        setTarget(undefined)
        setName('')
      })
      .catch((reason: unknown) => { setError(sentence(reason)) })
      .finally(() => { setBusy(false) })
  }

  const enter = (path: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void registerWorkspace(path)
      .then(workspaceId => openWorkspace(workspaceId))
      .catch((reason: unknown) => { setError(sentence(reason)) })
      .finally(() => { setBusy(false) })
  }

  /**
   * Drop one registration that no longer answers for a checkout.
   *
   * Only the sidebar row goes: the checkout is already gone, and a directory that
   * still exists but is not a repository is the user's to keep.
   * @param path - the registered directory.
   */
  const forget = (path: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void forgetWorkspace(path)
      .then(() => { load() })
      .catch((reason: unknown) => { setError(sentence(reason)) })
      .finally(() => { setBusy(false) })
  }

  /** Open the confirmation for one row; nothing is removed yet. */
  const ask = (repo: string, entry: WorktreeSummary): void => {
    if (busy) return
    setRemoveError(undefined)
    setPending({ repo, entry })
    // The row's own reading may be stale by now, so the dialog starts from the
    // freshest list instead of a number captured when the page loaded.
    load(true)
  }

  /** Leave the confirmation, keeping any failure visible on the page behind it. */
  const dismiss = (): void => {
    if (removing) return
    if (removeError !== undefined) setError(removeError)
    setPending(undefined)
    setRemoveError(undefined)
  }

  /**
   * Remove the pending checkout.
   * @param force - discard uncommitted changes and unmerged branch commits.
   */
  const confirm = (force: boolean): void => {
    if (pending === undefined || removing) return
    const { repo, entry } = pending
    setRemoving(true)
    setRemoveError(undefined)
    void removeWorktree(repo, entry.path, force)
      // The registration naming the removed checkout would otherwise be a
      // sidebar row pointing at nothing, so it goes too.
      .then(() => forgetWorkspace(entry.path))
      .then(() => {
        setPending(undefined)
        load()
      })
      .catch((reason: unknown) => {
        // Kept out of `error`: this one belongs in the dialog the user is
        // looking at, and dismissing the dialog promotes it to the page.
        setRemoveError(sentence(reason))
        // A branch refusal happens after the checkout is already gone, so the
        // rows behind the dialog still have to be re-read.
        load(true)
      })
      .finally(() => { setRemoving(false) })
  }

  const entryRow = (repo: string, entry: WorktreeSummary) => (
    <li key={entry.path} className={CLS.row}>
      <span className={CLS.rowText}>
        <span className={CLS.rowTitle} title={entry.path}>
          {entry.branch ?? t('detached')}
          {entry.main ? <span className={CLS.tag}>{t('mainCheckout')}</span> : null}
          {entry.locked ? <span className={CLS.tag}>{t('locked')}</span> : null}
          {entry.dirty !== undefined && entry.dirty > 0
            ? <span className={CLS.tag}>{t('dirtyCount', { count: entry.dirty })}</span>
            : null}
        </span>
        <span className={CLS.rowMeta} title={entry.path}>
          {entry.main ? tail(entry.path, 1) : below(repo, entry.path)}
          {' · '}
          {entry.head.slice(0, 8)}
        </span>
      </span>
      <span className={CLS.rowActions}>
        {entry.main ? null : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { enter(entry.path) }}>
            {t('enter')}
          </Button>
        )}
        {!entry.main && !entry.locked
          ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { ask(repo, entry) }}>
              {t('remove')}
            </Button>
          )
          : null}
      </span>
    </li>
  )

  const repoCard = (repo: RepoOverview) => (
    <section key={repo.repo} className={CLS.card}>
      <div className={CLS.cardHead}>
        <div>
          <h2 className={CLS.cardTitle}>{tail(repo.repo, 1)}</h2>
          <p className={CLS.cardPath}>{repo.repo}</p>
        </div>
        <div className={CLS.cardTools}>
          <span className={CLS.hint}>{t('worktreeCount', { count: repo.worktrees.length })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setName('')
              setTarget(repo)
            }}
          >
            {t('createHere')}
          </Button>
        </div>
      </div>
      {repo.worktrees.length === 0
        ? <p className={CLS.hint}>{t('repoEmpty')}</p>
        : <ul className={CLS.rows}>{repo.worktrees.map(entry => entryRow(repo.repo, entry))}</ul>}
    </section>
  )

  /**
   * The card for registrations no repository answers for.
   *
   * Without it these rows are unreachable: the section that offered their removal
   * belonged to a checkout that no longer exists, so the only way to drop them was
   * editing the workspace store by hand.
   */
  const unresolvedCard = data === undefined
    ? null
    : (
      <section className={CLS.card}>
        <div className={CLS.cardHead}>
          <div>
            <h2 className={CLS.cardTitle}>{t('unresolvedTitle')}</h2>
            <p className={CLS.cardPath}>{t('unresolvedHint')}</p>
          </div>
          <div className={CLS.cardTools}>
            <span className={CLS.hint}>{t('unresolvedCount', { count: data.unresolved.length })}</span>
          </div>
        </div>
        <ul className={CLS.rows}>
          {data.unresolved.map(item => (
            <li key={item.path} className={CLS.row}>
              <span className={CLS.rowText}>
                <span className={CLS.rowTitle} title={item.path}>
                  {tail(item.path, 2)}
                  <span className={CLS.tag}>
                    {item.reason === 'missing' ? t('unresolvedMissing') : t('unresolvedNotRepo')}
                  </span>
                </span>
                <span className={CLS.rowMeta} title={item.path}>{item.path}</span>
              </span>
              <span className={CLS.rowActions}>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { forget(item.path) }}>
                  {t('unresolvedForget')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    )

  const dirty = pending?.entry.dirty

  return (
    <div className={CLS.panel}>
      <header className={CLS.panelHeader}>
        <h1 className={CLS.panelTitle}>{t('panelTitle')}</h1>
        <div className={CLS.panelTools}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { load() }}>{t('refresh')}</Button>
        </div>
      </header>
      {/*
        Outside the scrolling body on purpose: a removal that failed at the bottom
        of a long list used to report into a paragraph scrolled out of view.
      */}
      {error !== undefined
        ? (
          <div className={CLS.alert} role="alert">
            <p className={CLS.alertText}>{error}</p>
            <Button variant="ghost" size="sm" onClick={() => { setError(undefined) }}>{t('dismiss')}</Button>
          </div>
        )
        : null}
      <div className={CLS.panelBody}>
        <section className={CLS.card}>
          <div className={CLS.cardHead}>
            <h2 className={CLS.cardTitle}>{t('settingsTitle')}</h2>
          </div>
          <div className={CLS.formRow}>
            <span className={CLS.formLabel}>{t('settingsParent')}</span>
            <span className={CLS.formControl}>
              <Input
                value={parent}
                placeholder={t('settingsParentPlaceholder')}
                aria-label={t('settingsParent')}
                onChange={(event) => { setParent(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    save()
                  }
                }}
              />
              <p className={CLS.hint}>{t('settingsParentHint')}</p>
            </span>
          </div>
          <div className={CLS.formRow}>
            <span className={CLS.formLabel}>{t('settingsFetch')}</span>
            <span className={CLS.formControl}>
              <Switch
                checked={fetchUpstream}
                onChange={setFetchUpstream}
                label={t('settingsFetch')}
              />
              <p className={CLS.hint}>{t('settingsFetchHint')}</p>
            </span>
          </div>
          <div className={CLS.cardFoot}>
            {saved ? <span className={CLS.hint} role="status">{t('settingsSaved')}</span> : null}
            <Button variant="primary" size="sm" disabled={saving} onClick={save}>
              {saving ? t('busy') : t('settingsSave')}
            </Button>
          </div>
        </section>

        {data === undefined
          ? <p className={CLS.hint} role="status">{t('loading')}</p>
          : data.repos.length === 0
            ? <p className={CLS.hint}>{t('empty')}</p>
            : data.repos.map(repoCard)}
        {data !== undefined && data.unresolved.length > 0 ? unresolvedCard : null}
      </div>
      <Modal
        open={target !== undefined}
        onClose={() => { if (!busy) { setTarget(undefined); setName('') } }}
        title={t('createTitle')}
        closeLabel={t('cancel')}
        description={t('createDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setTarget(undefined); setName('') }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={create}>
              {busy ? t('busy') : t('create')}
            </Button>
          </>
        )}
      >
        <div className={CLS.field}>
          <label className={CLS.label} htmlFor="dshw-new-name">{t('nameLabel')}</label>
          <Input
            id="dshw-new-name"
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
            {t('location', { path: `${parent === '' ? `${target?.repo ?? ''}\\.agents\\worktrees` : `${parent}\\${tail(target?.repo ?? '', 1)}`}\\${name.trim() || '…'}` })}
          </p>
        </div>
      </Modal>
      <Modal
        open={pending !== undefined}
        onClose={dismiss}
        title={t('removeTitle')}
        closeLabel={t('cancel')}
        description={t('removeDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={removing} onClick={dismiss}>{t('cancel')}</Button>
            <Button variant="outline" disabled={removing} onClick={() => { confirm(true) }}>
              {t('forceRemove')}
            </Button>
            <Button variant="primary" disabled={removing} onClick={() => { confirm(false) }}>
              {removing ? t('busy') : t('remove')}
            </Button>
          </>
        )}
      >
        <div className={CLS.field}>
          <p className={CLS.hint}>{t('removePath')}：{pending?.entry.path ?? ''}</p>
          <p className={CLS.hint}>{t('removeBranch')}：{pending?.entry.branch ?? t('detached')}</p>
          {dirty === undefined
            ? null
            : dirty > 0
              ? <p className={CLS.hint}>{t('removeDirty', { count: dirty })}</p>
              : <p className={CLS.hint}>{t('removeClean')}</p>}
          {removeError !== undefined ? <p className={CLS.error} role="alert">{removeError}</p> : null}
          {dirty !== undefined && dirty > 0 ? <p className={CLS.hint}>{t('forceRemoveHint')}</p> : null}
        </div>
      </Modal>
    </div>
  )
}
