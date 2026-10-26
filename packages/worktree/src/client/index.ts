/**
 * Worktrees for DSH — browser half.
 *
 * Two seats, one idea:
 *
 * - The **create control**, in the Session title bar and the New Session row:
 *   one dialog that branches a checkout from the current Session's repository and
 *   continues inside it.
 * - The **Worktrees page**, a main panel: the plugin settings (checkout
 *   directory, fetch-before-create) and every repository's checkouts, grouped by
 *   repository, with enter and remove.
 *
 * Creating a checkout is a Host job (the page cannot run `git`); adopting one is
 * the harness's own business — registered through the Workspace controller and
 * opened through the Workspace UI, the very steps the directory picker performs.
 *
 * @module @free-lzj/dsh-worktree/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  CREATE_PATH, MUTATION_HEADER, OVERVIEW_PATH, REMOVE_PATH, SETTINGS_PATH,
  type CreateWorktreeResult, type FailureResult, type OverviewResult, type RemoveWorktreeResult,
  type WorktreeSettings,
} from '../protocol.ts'
import { NS, en, zh, type WorktreeKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { WorktreeAction, type WorktreeActionInjected } from './WorktreeAction.tsx'
import { WorktreesPanel, type WorktreesPanelInjected } from './WorktreesPanel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Worktree control and page copy. */
    worktree: WorktreeKey
  }
}

export type { WorktreeActionInjected, WorktreeActionProps } from './WorktreeAction.tsx'
export type { WorktreesPanelInjected, WorktreesPanelProps } from './WorktreesPanel.tsx'

/** Required services: slots, dictionaries, the Workspace controller, navigation, and the layout. */
export const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace', 'layout']

/** The `main` panel key the sidebar row selects. */
const PANEL_KEY = 'worktrees'

/**
 * Read one JSON answer, turning a refusal into the Host's own sentence.
 * @param response - the fetch result.
 * @param fallback - prefix when the answer carried no `error`.
 * @returns the parsed body.
 */
async function readAnswer<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json() as unknown
  if (!response.ok) {
    const failure = body as Partial<FailureResult> | null
    throw new Error(typeof failure?.error === 'string' ? failure.error : `${fallback}（HTTP ${response.status}）`)
  }
  return body as T
}

/**
 * Create one worktree through the Host.
 * @param dir - directory whose repository to branch from.
 * @param name - requested name; omitted means the Host generates one.
 * @returns the created checkout.
 */
function createOnHost(dir: string, name?: string): Promise<CreateWorktreeResult> {
  return fetch(CREATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
    body: JSON.stringify({ dir, ...name === undefined ? {} : { name } }),
  }).then(response => readAnswer<CreateWorktreeResult>(response, '创建失败'))
}

/** @returns every repository's checkouts plus the settings. */
function overviewOnHost(): Promise<OverviewResult> {
  return fetch(OVERVIEW_PATH, { cache: 'no-store' })
    .then(response => readAnswer<OverviewResult>(response, '读取失败'))
}

/**
 * Remove one checkout (and its branch) through the Host.
 * @param dir - directory whose repository owns the checkout.
 * @param path - checkout to remove.
 * @returns what was removed.
 */
function removeOnHost(dir: string, path: string): Promise<RemoveWorktreeResult> {
  return fetch(REMOVE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
    body: JSON.stringify({ dir, path, deleteBranch: true }),
  }).then(response => readAnswer<RemoveWorktreeResult>(response, '删除失败'))
}

/** @returns the settings in effect. */
function settingsOnHost(): Promise<WorktreeSettings> {
  return fetch(SETTINGS_PATH, { cache: 'no-store' })
    .then(response => readAnswer<WorktreeSettings>(response, '读取设置失败'))
}

/**
 * Persist one settings write.
 * @param patch - the fields to change.
 * @returns the settings now in effect.
 */
function saveSettingsOnHost(patch: Partial<WorktreeSettings>): Promise<WorktreeSettings> {
  return fetch(SETTINGS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
    body: JSON.stringify(patch),
  }).then(response => readAnswer<WorktreeSettings>(response, '保存设置失败'))
}

/**
 * Compare two Workspace paths the way Windows does.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they name the same directory.
 */
function samePath(left: string, right: string): boolean {
  const norm = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * Client plugin body: dictionaries, stylesheet, the create control in both of its
 * seats, and the Worktrees page with its sidebar row.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'worktree: dictionaries')
  ctx.effect(installStyles, 'worktree: stylesheet')

  /** Drop the registration that names this checkout, if the user made one. */
  const forget = async (path: string): Promise<void> => {
    const match = ctx.workspaces.list.getSnapshot().items.find(item => samePath(item.path, path))
    if (match !== undefined) await ctx.workspaces.delete(match.workspaceId)
  }

  const control = (): WorktreeActionInjected => ({
    createWorktree: (dir, name) => createOnHost(dir, name),
    registerWorkspace: async (path) => (await ctx.workspaces.create({ path })).workspaceId,
    openWorkspace: async (workspaceId) => {
      await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<typeof ctx.uiWorkspace.openWorkspace>[0])
    },
    openManager: () => { ctx.layout.selectPanel(PANEL_KEY as Parameters<typeof ctx.layout.selectPanel>[0]) },
    settings: () => settingsOnHost(),
  })

  const page = (): WorktreesPanelInjected => ({
    overview: () => overviewOnHost(),
    saveSettings: patch => saveSettingsOnHost(patch),
    createWorktree: (dir, name) => createOnHost(dir, name),
    removeWorktree: (dir, path) => removeOnHost(dir, path),
    registerWorkspace: async (path) => (await ctx.workspaces.create({ path })).workspaceId,
    forgetWorkspace: path => forget(path),
    openWorkspace: async (workspaceId) => {
      await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<typeof ctx.uiWorkspace.openWorkspace>[0])
    },
  })

  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'worktree',
    // The row is read left to right: workspace, preset, then this option.
    order: 100,
    locale: NS,
    inject: control,
  }, WorktreeAction))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'worktree',
    // After the shipped session actions, which group around the title itself.
    order: 100,
    locale: NS,
    inject: control,
  }, WorktreeAction))

  // The panel seat and its sidebar row. Both names are the shell's own slots; the
  // `as never` casts are the price of registering into another package's slot
  // table, which this package's type program cannot see (the same shape the
  // workbench contract uses for its adopters).
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_KEY,
    locale: NS,
    inject: page,
  } as never, WorktreesPanel as never))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_KEY,
    order: 45,
    locale: NS,
    label: () => t('panel'),
  } as never, IconBranchOutlineRegular as never))
}
