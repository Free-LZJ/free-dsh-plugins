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

/** How long an armed removal waits for its confirming press before disarming. */
const CONFIRM_MS = 3_000

/** What the registration hands the page: Host calls and navigation. */
export interface WorktreesPanelInjected {
  /** Read every repository's checkouts plus the settings. */
  overview: () => Promise<OverviewResult>
  /** Persist one settings write. */
  saveSettings: (patch: Partial<WorktreeSettings>) => Promise<WorktreeSettings>
  /** Create one checkout in a repository; resolves it. */
  createWorktree: (dir: string, name?: string) => Promise<{ path: string; branch: string; base: string; warning?: string }>
  /** Remove one checkout, and its branch, through the Host. */
  removeWorktree: (dir: string, path: string) => Promise<{ removed: string; branch?: string }>
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
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [target, setTarget] = useState<RepoOverview | undefined>(undefined)
  const [name, setName] = useState('')

  const load = useCallback((): void => {
    setError(undefined)
    void overview()
      .then((result) => {
        setData(result)
        setParent(result.settings.parent)
        setFetchUpstream(result.settings.fetchBeforeCreate)
      })
      .catch((reason: unknown) => {
        setData({ settings: { parent: '', fetchBeforeCreate: true }, repos: [] })
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [overview])

  useEffect(() => { load() }, [load])

  // An armed removal disarms on its own, so a first press never becomes a
  // delete waiting for a stray second one.
  useEffect(() => {
    if (armed === undefined) return
    const timer = setTimeout(() => { setArmed(undefined) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [armed])

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
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
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
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const enter = (path: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void registerWorkspace(path)
      .then(workspaceId => openWorkspace(workspaceId))
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const remove = (repo: string, path: string): void => {
    if (busy) return
    if (armed !== path) {
      setArmed(path)
      return
    }
    setBusy(true)
    setArmed(undefined)
    setError(undefined)
    void removeWorktree(repo, path)
      // The registration naming the removed checkout would otherwise be a
      // sidebar row pointing at nothing, so it goes too.
      .then(() => forgetWorkspace(path))
      .then(() => { load() })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        load()
      })
      .finally(() => { setBusy(false) })
  }

  const entryRow = (repo: string, entry: WorktreeSummary) => (
    <li key={entry.path} className={CLS.row}>
      <span className={CLS.rowText}>
        <span className={CLS.rowTitle} title={entry.path}>
          {entry.branch ?? t('detached')}
          {entry.main ? <span className={CLS.tag}>{t('mainCheckout')}</span> : null}
          {entry.locked ? <span className={CLS.tag}>{t('locked')}</span> : null}
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
        {entry.managed && !entry.main && !entry.locked
          ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { remove(repo, entry.path) }}>
              {armed === entry.path ? t('removeConfirm') : t('remove')}
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

  return (
    <div className={CLS.panel}>
      <header className={CLS.panelHeader}>
        <h1 className={CLS.panelTitle}>{t('panelTitle')}</h1>
        <div className={CLS.panelTools}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={load}>{t('refresh')}</Button>
        </div>
      </header>
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

        {error !== undefined ? <p className={CLS.error} role="alert">{error}</p> : null}
        {data === undefined
          ? <p className={CLS.hint} role="status">{t('loading')}</p>
          : data.repos.length === 0
            ? <p className={CLS.hint}>{t('empty')}</p>
            : data.repos.map(repoCard)}
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
    </div>
  )
}
