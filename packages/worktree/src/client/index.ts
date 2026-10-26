/**
 * Worktree picker for DSH — browser half.
 *
 * One contribution: the New Session row's worktree control. Creating the
 * checkout is a Host job (the page cannot run `git`), while adopting it is the
 * harness's own business — the checkout is registered through the Workspace
 * controller and opened through the Workspace UI, the very two steps the
 * directory picker performs, so a worktree session is indistinguishable from any
 * other session afterwards.
 *
 * @module @free-lzj/dsh-worktree/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  CREATE_PATH, MUTATION_HEADER, type CreateWorktreeResult, type FailureResult,
} from '../protocol.ts'
import { NS, en, zh, type WorktreeKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { WorktreeAction, type WorktreeActionInjected } from './WorktreeAction.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Worktree picker copy. */
    worktree: WorktreeKey
  }
}

export type { WorktreeActionInjected, WorktreeActionProps } from './WorktreeAction.tsx'

/** Required services: slots, dictionaries, the Workspace controller, and Workspace navigation. */
export const inject = ['slots', 'locale', 'workspaces', 'uiWorkspace']

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
 * Client plugin body: register the dictionaries, the stylesheet, and the Hero
 * control.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'worktree: dictionaries')
  ctx.effect(installStyles, 'worktree: stylesheet')
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'worktree',
    // The row is read left to right: workspace, preset, then this option.
    order: 100,
    locale: NS,
    inject: (): WorktreeActionInjected => ({
      createWorktree: (dir, name) => createOnHost(dir, name),
      registerWorkspace: async (path) => (await ctx.workspaces.create({ path })).workspaceId,
      openWorkspace: async (workspaceId) => {
        // The id is this plugin's own return value from the controller; the
        // brand is nominal typing only.
        await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<typeof ctx.uiWorkspace.openWorkspace>[0])
      },
    }),
  }, WorktreeAction))
}
