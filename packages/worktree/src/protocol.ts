/**
 * The requests this plugin speaks over HTTP, in both halves' vocabulary.
 *
 * The browser cannot run `git`, so every checkout operation is a Host one; the
 * only thing the two halves share is these shapes and the routes they are sent
 * to. Nothing here is Node-specific, so the browser bundle inlines values and
 * types only.
 *
 * @module @free-dsh/worktree/protocol
 */

/** Where the browser asks for a new worktree. */
export const CREATE_PATH = '/dsh-worktrees/create'

/** Where the browser reads every repository's checkouts plus the plugin settings. */
export const OVERVIEW_PATH = '/dsh-worktrees/overview'

/** Where the browser asks for one checkout to be removed. */
export const REMOVE_PATH = '/dsh-worktrees/remove'

/** Where the browser reads and writes the plugin settings. */
export const SETTINGS_PATH = '/dsh-worktrees/settings'

/**
 * The default parent directory, relative to the repository root. The official
 * worktree runtime uses the same layout, so a checkout made here nests under its
 * repository in the sidebar exactly like one made by `create_worktree`.
 */
export const WORKTREE_PARENT = '.agents/worktrees'

/** Header a mutating request must carry, so a cross-site form cannot post it. */
export const MUTATION_HEADER = 'x-dsh-worktrees'

/** Largest body the routes read; every payload here is one path and one name. */
export const MAX_BODY_BYTES = 4 * 1024

/** What the Host remembers between sessions. */
export interface WorktreeSettings {
  /**
   * Absolute directory that holds every checkout, or empty for the default
   * `<repo>/.agents/worktrees`. A configured directory keeps each repository's
   * checkouts in a subdirectory named after the repository, so two repositories
   * with the same branch name never collide.
   */
  readonly parent: string
  /** Fetch upstream refs (and branch from them) before creating a checkout. */
  readonly fetchBeforeCreate: boolean
}

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
  /** What the new branch starts at: an upstream ref, or `HEAD`. */
  readonly base: string
  /** A fetch or upstream problem that did not stop the creation. */
  readonly warning?: string
}

/** One checkout as the browser lists it. */
export interface WorktreeSummary {
  /** Absolute path of the checkout. */
  readonly path: string
  /** Branch name; absent for a detached checkout. */
  readonly branch?: string
  /** Commit the checkout is at. */
  readonly head: string
  /** Whether this is the repository's own checkout. */
  readonly main: boolean
  /** Git holds a lock on it, so it cannot be removed without a force. */
  readonly locked: boolean
  /** Whether it lives under a managed parent, i.e. is removable here. */
  readonly managed: boolean
}

/** Every checkout of one repository. */
export interface RepoOverview {
  /** Top level of the repository. */
  readonly repo: string
  /** Its checkouts, the repository's own first. */
  readonly worktrees: readonly WorktreeSummary[]
}

/** What the management page reads in one request. */
export interface OverviewResult {
  /** Settings the page edits. */
  readonly settings: WorktreeSettings
  /** One entry per distinct repository among the registered Workspaces. */
  readonly repos: readonly RepoOverview[]
}

/** One removal request from the browser. */
export interface RemoveWorktreeRequest {
  /** Directory whose repository owns the checkout. */
  readonly dir: string
  /** Checkout to remove. */
  readonly path: string
  /** Whether to drop the checkout's branch too. */
  readonly deleteBranch?: boolean
}

/** What a successful removal reports. */
export interface RemoveWorktreeResult {
  /** Path that is gone. */
  readonly removed: string
  /** Branch that was dropped with it, when one was. */
  readonly branch?: string
}

/** One settings write from the browser. */
export interface SettingsRequest {
  /** Absolute directory, or empty to restore the default. */
  readonly parent?: string
  /** Whether to fetch upstream refs before creating a checkout. */
  readonly fetchBeforeCreate?: boolean
}

/** Failure answer: one sentence, never the request echoed back. */
export interface FailureResult {
  readonly error: string
}
