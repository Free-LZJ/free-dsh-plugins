/**
 * The one request this plugin speaks over HTTP, in both halves' vocabulary.
 *
 * The browser cannot run `git`, so creating a worktree is a Host operation; the
 * only thing the two halves share is this shape and the route it is posted to.
 * Nothing here is runtime code, so the browser bundle inlines types only.
 *
 * @module @free-dsh/worktree/protocol
 */

/** Where the browser asks for a worktree. */
export const CREATE_PATH = '/dsh-worktrees/create'

/**
 * The parent directory every checkout is created under, relative to the
 * repository root. The official worktree runtime uses the same layout, so a
 * checkout made here nests under its repository in the sidebar exactly like one
 * made by `create_worktree`.
 */
export const WORKTREE_PARENT = '.agents/worktrees'

/** Header a mutating request must carry, so a cross-site form cannot post it. */
export const MUTATION_HEADER = 'x-dsh-worktrees'

/** Largest body the route reads; the payload is one path and one short name. */
export const MAX_BODY_BYTES = 4 * 1024

/** One create request from the browser. */
export interface CreateWorktreeRequest {
  /** Directory whose repository the worktree branches from. */
  readonly dir: string
  /** Branch and directory name; omitted means the Host generates one. */
  readonly name?: string
}

/** A created worktree, as the browser needs it to adopt a Workspace. */
export interface CreateWorktreeResult {
  /** Absolute path of the new checkout. */
  readonly path: string
  /** Branch created for it. */
  readonly branch: string
  /** Top level of the repository the checkout was branched from. */
  readonly repo: string
}

/** Failure answer: one sentence, never the request echoed back. */
export interface FailureResult {
  readonly error: string
}
