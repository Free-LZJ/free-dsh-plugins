/**
 * Worktrees and Workspaces for DSH — browser half.
 *
 * Two contributions, one package because they answer the same question twice:
 * which checkout a Session runs in.
 *
 * - The **worktree control**, in the New Session row and the Session title bar.
 *   Creating a checkout is a Host job (the page cannot run `git`); adopting it is
 *   the harness's own business — registered through the Workspace controller and
 *   opened through the Workspace UI, the very steps the directory picker
 *   performs, so a worktree session is indistinguishable afterwards.
 * - The **Workspaces page**, which lists what DSH has registered and drops a
 *   registration. Nothing there touches a file: DSH keeps the folder and every
 *   Session log, and the Sessions become ungrouped.
 *
 * @module @free-lzj/dsh-worktree/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { IconFolderOpenRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  CREATE_PATH, LIST_PATH, MUTATION_HEADER, REMOVE_PATH,
  type CreateWorktreeResult, type FailureResult, type ListWorktreesResult, type RemoveWorktreeResult,
} from '../protocol.ts'
import { NS, en, zh, type WorktreeKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { WorktreeAction, type WorktreeActionInjected } from './WorktreeAction.tsx'
import { WorkspacesPanel, type WorkspacesPanelInjected } from './WorkspacesPanel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Worktree picker and Workspaces page copy. */
    worktree: WorktreeKey
  }
}

export type { WorktreeActionInjected, WorktreeActionProps } from './WorktreeAction.tsx'
export type { WorkspacesPanelInjected, WorkspacesPanelProps } from './WorkspacesPanel.tsx'

/** Required services: slots, dictionaries, the Workspace controller, and Workspace navigation. */
export const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace']

/** The `main` panel key the sidebar row selects. */
const PANEL_KEY = 'workspaces'

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
 * Create one worktree through the Host.
 * @param dir - directory whose repository to branch from.
 * @param name - requested name; omitted means the Host generates one.
 * @returns the created checkout.
 */
async function createOnHost(dir: string, name?: string): Promise<CreateWorktreeResult> {
  const response = await fetch(CREATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
    body: JSON.stringify({ dir, ...name === undefined ? {} : { name } }),
  })
  const body = await response.json() as CreateWorktreeResult | FailureResult
  if (!response.ok) {
    const message = 'error' in body ? body.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as CreateWorktreeResult
}

/**
 * Read one repository's checkouts through the Host.
 * @param dir - directory whose repository to read.
 * @returns the repository and its checkouts.
 */
async function listOnHost(dir: string): Promise<ListWorktreesResult> {
  const query = new URLSearchParams({ dir }).toString()
  const response = await fetch(`${LIST_PATH}?${query}`, { cache: 'no-store' })
  const body = await response.json() as ListWorktreesResult | FailureResult
  if (!response.ok) throw new Error('error' in body ? body.error : `HTTP ${response.status}`)
  return body as ListWorktreesResult
}

/**
 * Remove one checkout (and its branch) through the Host.
 *
 * The branch goes with it: Git's own `-d` refuses an unmerged branch, so the
 * refusal is the safety check rather than something this half re-implements.
 * @param dir - directory whose repository owns the checkout.
 * @param path - checkout to remove.
 * @returns what was removed.
 */
async function removeOnHost(dir: string, path: string): Promise<RemoveWorktreeResult> {
  const response = await fetch(REMOVE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [MUTATION_HEADER]: '1' },
    body: JSON.stringify({ dir, path, deleteBranch: true }),
  })
  const body = await response.json() as RemoveWorktreeResult | FailureResult
  if (!response.ok) throw new Error('error' in body ? body.error : `HTTP ${response.status}`)
  return body as RemoveWorktreeResult
}

/**
 * Client plugin body: dictionaries, stylesheet, the worktree control in both of
 * its seats, and the Workspaces page with its sidebar row.
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

  const face = (): WorktreeActionInjected => ({
    createWorktree: (dir, name) => createOnHost(dir, name),
    listWorktrees: dir => listOnHost(dir),
    removeWorktree: (dir, path) => removeOnHost(dir, path),
    registerWorkspace: async (path) => (await ctx.workspaces.create({ path })).workspaceId,
    openWorkspace: async (workspaceId) => {
      // The id is this plugin's own return value from the controller; the brand
      // is nominal typing only.
      await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<typeof ctx.uiWorkspace.openWorkspace>[0])
    },
    forgetWorkspace: path => forget(path),
  })

  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'worktree',
    // The row is read left to right: workspace, preset, then this option.
    order: 100,
    locale: NS,
    inject: face,
  }, WorktreeAction))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'worktree',
    // After the shipped session actions, which group around the title itself.
    order: 100,
    locale: NS,
    inject: face,
  }, WorktreeAction))

  // The panel seat and its sidebar row. Both names are the shell's own slots; the
  // `as never` casts are the price of registering into another package's slot
  // table, which this package's type program cannot see (same shape the workbench
  // contract uses for its adopters).
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_KEY,
    locale: NS,
    inject: (): WorkspacesPanelInjected => ({
      remove: async (workspaceId) => {
        // The controller's id brand is nominal typing only.
        await ctx.workspaces.delete(workspaceId as Parameters<typeof ctx.workspaces.delete>[0])
      },
    }),
  } as never, WorkspacesPanel as never))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_KEY,
    order: 45,
    locale: NS,
    label: () => t('panel'),
  } as never, IconFolderOpenRegular as never))
}
