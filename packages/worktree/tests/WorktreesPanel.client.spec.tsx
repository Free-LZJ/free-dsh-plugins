// @vitest-environment jsdom
/**
 * The removal flow as a user meets it: the pressed row opens a dialog that names
 * what would be lost, a refusal shows up inside that dialog, forcing it goes
 * through, and dismissing the dialog leaves the reason on the page.
 *
 * These are the two regressions the report was really about: a removal that
 * failed said nothing because the refresh that followed it cleared the error,
 * and a checkout with local work could never be removed at all.
 *
 * @module @free-lzj/dsh-worktree/tests/WorktreesPanel
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverviewResult, UnresolvedWorkspace, WorktreeSummary } from '../src/protocol.ts'
import { WorktreesPanel } from '../src/client/WorktreesPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Translate through the real dictionary, so a missing key fails here too.
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns the rendered sentence.
 */
function translate(key: keyof typeof zh, params?: Record<string, string | number>): string {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

/** The repository's own checkout; never removable. */
const MAIN: WorktreeSummary = { path: 'D:\\repo', head: 'abcdef1234567890', main: true, locked: false }

/** A linked checkout holding three uncommitted entries. */
const LINKED: WorktreeSummary = {
  path: 'D:\\repo\\.agents\\worktrees\\dirty',
  branch: 'dirty',
  head: 'abcdef1234567890',
  main: false,
  locked: false,
  dirty: 3,
}

/**
 * @returns the overview the page reads on every load.
 */
async function overview(): Promise<OverviewResult> {
  return {
    settings: { parent: '', fetchBeforeCreate: true },
    repos: [{ repo: 'D:\\repo', worktrees: [MAIN, LINKED] }],
    unresolved: [],
  }
}

/** One removal the page asked for, in order. */
interface Asked {
  readonly dir: string
  readonly path: string
  readonly force: boolean | undefined
}

/**
 * Render the page with a removal that answers however the case needs.
 * @param answer - what the Host does for one removal request.
 * @returns every request the page made.
 */
function page(
  answer: (dir: string, path: string, force?: boolean) => Promise<{ removed: string; branch?: string }>,
  options: {
    overview?: () => Promise<OverviewResult>
    forget?: (path: string) => Promise<void>
  } = {},
): Asked[] {
  const asked: Asked[] = []
  const removeWorktree = vi.fn(async (dir: string, path: string, force?: boolean) => {
    asked.push({ dir, path, force })
    return answer(dir, path, force)
  })
  const props = {
    overview: options.overview ?? overview,
    saveSettings: async () => ({ parent: '', fetchBeforeCreate: true }),
    createWorktree: async () => ({ path: '', branch: '', base: 'HEAD' }),
    removeWorktree,
    registerWorkspace: async () => 'ws',
    forgetWorkspace: options.forget ?? (async () => {}),
    openWorkspace: async () => {},
    t: translate,
  } as unknown as Parameters<typeof WorktreesPanel>[0]
  render(<WorktreesPanel {...props} />)
  return asked
}

/**
 * Press the row's own remove button.
 * @returns nothing; the dialog is queried by the caller.
 */
async function pressRemove(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: translate('remove') }))
  await screen.findByRole('dialog')
}

describe('removing a worktree', () => {
  it('tags a row with the amount of uncommitted work it holds', async () => {
    page(async (_dir, path) => ({ removed: path }))
    expect(await screen.findByText(translate('dirtyCount', { count: 3 }))).toBeTruthy()
  })

  it('opens a dialog naming the checkout and the work it would lose', async () => {
    page(async (_dir, path) => ({ removed: path }))
    await pressRemove()

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(translate('removeTitle'))
    expect(dialog.textContent).toContain(LINKED.path)
    expect(dialog.textContent).toContain('dirty')
    expect(dialog.textContent).toContain(translate('removeDirty', { count: 3 }))
  })

  it('removes without force first, and shows Git\'s refusal inside the dialog', async () => {
    const asked = page(async () => {
      throw new Error('contains modified or untracked files, use --force to delete it')
    })
    await pressRemove()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: translate('remove') }))

    await waitFor(() => {
      expect(screen.getByRole('dialog').textContent).toContain('use --force')
    })
    expect(asked).toEqual([{ dir: 'D:\\repo', path: LINKED.path, force: false }])
    // The dialog is still up: a refusal is answered where it was asked.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('removes the checkout once the user forces it', async () => {
    const asked = page(async (_dir, path, force) => {
      if (force !== true) throw new Error('contains modified or untracked files')
      return { removed: path, branch: 'dirty' }
    })
    await pressRemove()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: translate('remove') }))
    await waitFor(() => { expect(screen.getByRole('dialog').textContent).toContain('contains modified') })

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: translate('forceRemove') }))

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(asked).toEqual([
      { dir: 'D:\\repo', path: LINKED.path, force: false },
      { dir: 'D:\\repo', path: LINKED.path, force: true },
    ])
  })

  it('leaves the refusal on the page after the dialog is dismissed', async () => {
    page(async () => {
      throw new Error('contains modified or untracked files')
    })
    await pressRemove()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: translate('remove') }))
    await waitFor(() => { expect(screen.getByRole('dialog').textContent).toContain('contains modified') })

    const cancels = within(screen.getByRole('dialog')).getAllByRole('button', { name: translate('cancel') })
    fireEvent.click(cancels[cancels.length - 1] as HTMLElement)

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    // The regression: this sentence used to be cleared by the refresh behind it.
    expect(screen.getByRole('alert').textContent).toContain('contains modified')
  })
})

describe('registrations that lead nowhere', () => {
  const GONE = 'D:\\repo\\.agents\\worktrees\\gone'

  it('lists a registration whose checkout no longer exists', async () => {
    page(async (_dir, path) => ({ removed: path }), {
      overview: async () => ({
        settings: { parent: '', fetchBeforeCreate: true },
        repos: [{ repo: 'D:\\repo', worktrees: [MAIN] }],
        unresolved: [{ path: GONE, reason: 'missing' as const }],
      }),
    })

    expect(await screen.findByText(translate('unresolvedTitle'))).toBeTruthy()
    expect(screen.getByText(translate('unresolvedMissing'))).toBeTruthy()
    expect(screen.getByText(GONE)).toBeTruthy()
  })

  it('drops the registration when asked, and the card goes with it', async () => {
    let unresolved: UnresolvedWorkspace[] = [{ path: GONE, reason: 'missing' }]
    const forgotten: string[] = []
    page(async (_dir, path) => ({ removed: path }), {
      overview: async () => ({
        settings: { parent: '', fetchBeforeCreate: true },
        repos: [{ repo: 'D:\\repo', worktrees: [MAIN] }],
        unresolved,
      }),
      // The Host drops the registration, so the refresh no longer sees it.
      forget: async (path) => { forgotten.push(path); unresolved = [] },
    })

    fireEvent.click(await screen.findByRole('button', { name: translate('unresolvedForget') }))

    await waitFor(() => { expect(forgotten).toEqual([GONE]) })
    await waitFor(() => { expect(screen.queryByText(translate('unresolvedTitle'))).toBeNull() })
  })
})
