/**
 * Worktree picker for DSH — Host half.
 *
 * One job: create a Git worktree on request. The browser cannot run `git`, so
 * this half owns the route the New Session dialog posts to; everything after
 * creation — registering the checkout as a Workspace, opening a blank Session in
 * it — is the browser half's business through the harness's own services, so
 * this package never touches the Session or Workspace registries.
 *
 * @module @free-lzj/dsh-worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerRoutes } from './routes.ts'

export { createWorktree, worktreeName } from './git.ts'
export type { CreatedWorktree } from './git.ts'
export * from './protocol.ts'
export { isMutationRequest, isSameOrigin, registerRoutes, respond } from './routes.ts'

/**
 * Mount the create route.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: Context): void {
  registerRoutes(ctx)
  ctx.logger.info('worktrees: create route mounted')
}
