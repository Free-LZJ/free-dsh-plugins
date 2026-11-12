/**
 * The `bsk` CLI, as this plugin drives it.
 *
 * Everything below is one process per command: no long-lived pipe, no protocol of
 * our own. `bsk` already owns the browser side — the daemon, the extension, the
 * borrowed-tab lifecycle — so the only thing worth building here is (a) one
 * session reused across calls, and (b) the borrow/act/return bracket, which is
 * what keeps a user tab from staying borrowed after a single read.
 *
 * @module @free-lzj/dsh-browser-use/bsk
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserTab, TabAction } from './protocol.ts'

/** How to reach the CLI. */
export interface BskConfig {
  /** Executable name or absolute path; `bsk` on PATH by default. */
  readonly path: string
  /** Name the browser's own control overlay shows, so the user knows who is driving. */
  readonly agentName: string
  /** Per-command ceiling; starting a session opens a window, reading a page does not. */
  readonly timeoutMs: number
}

/** One action asked of one borrowed tab. */
export interface TabRequest {
  readonly tabId: number
  readonly action: TabAction
  /** Element ref (`@e3`) for click/fill, URL for navigate; unused elsewhere. */
  readonly target?: string
  /** Text to type, for fill. */
  readonly value?: string
}

/** What one action produced. */
export interface TabActionResult {
  /** The command's own output, already trimmed. */
  readonly text: string
  /** Where a screenshot landed, when the action was one. */
  readonly path?: string
}

/**
 * The default executable.
 *
 * An environment override exists because a machine can have more than one `bsk`
 * on PATH (a stale global install next to the one the extension pairs with), and
 * picking the wrong one fails as an opaque transport error. One variable beats a
 * settings page for a value a user sets at most once.
 */
const DEFAULT_PATH = 'bsk'

/** How long any single CLI call may take. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Read one raw tab row into the shape the menu uses, or nothing.
 * @param value - one element of `bsk`'s `tabs` array.
 * @returns the tab, or undefined when the row is not one we can mention.
 */
function readTab(value: unknown): BrowserTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const tabId = row.tab_id
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return undefined
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const url = typeof row.url === 'string' ? row.url.trim() : ''
  // A tab with neither a title nor a URL cannot be described in a menu row, and
  // an agent asked to open one would be guessing.
  if (title === '' && url === '') return undefined
  return { tabId, title: title === '' ? url : title, url, active: row.active === true }
}

/**
 * One `bsk` session, started on first use.
 *
 * Reused rather than per-call: `session start` opens a window, which is a visible
 * interruption and takes seconds. The session lives as long as this plugin does
 * and is stopped in its disposer.
 */
export class BskCli {
  readonly #config: BskConfig
  #session: Promise<string> | undefined

  /**
   * @param config - executable, overlay label, and per-command ceiling.
   */
  constructor(config: Partial<BskConfig> = {}) {
    this.#config = {
      path: config.path ?? process.env['DSH_BSK_PATH'] ?? DEFAULT_PATH,
      agentName: config.agentName ?? 'DSH',
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  /**
   * The active session id, starting one when there is none.
   *
   * A failed start is dropped instead of cached: a browser that was closed and
   * reopened must be able to answer the next `@` without a restart of DSH.
   * @returns the session id.
   */
  async ensureSession(): Promise<string> {
    if (this.#session === undefined) {
      const starting = this.#start()
      this.#session = starting
      starting.catch(() => {
        if (this.#session === starting) this.#session = undefined
      })
    }
    return this.#session
  }

  /**
   * Every tab in the user's own windows.
   *
   * `--scope user` and not `all`: the agent's own Agent Window is a tool this
   * plugin drives, never something the user meant to mention.
   * @returns the tabs, most useful first (active tabs lead within a window).
   */
  async listUserTabs(): Promise<readonly BrowserTab[]> {
    const session = await this.ensureSession()
    const stdout = await this.#run(['tab', 'list', '--scope', 'user', '--json', '--session', session])
    const parsed = JSON.parse(stdout) as { tabs?: readonly unknown[] }
    if (!Array.isArray(parsed.tabs)) return []
    const tabs: BrowserTab[] = []
    for (const row of parsed.tabs) {
      const tab = readTab(row)
      if (tab !== undefined) tabs.push(tab)
    }
    // The tab the user is looking at is the one they most likely mean; within a
    // window the browser's own order is otherwise the honest one.
    return [...tabs.filter(tab => tab.active), ...tabs.filter(tab => !tab.active)]
  }

  /**
   * Run one action against a user tab, borrowing it for exactly that long.
   *
   * The bracket is not optional: `bsk` protects user tabs, so an unborrowed tab
   * answers nothing, and a borrowed one left behind keeps the browser's control
   * marker on a tab nobody is using.
   * @param request - tab, action, and the action's own argument.
   * @returns the action's output.
   */
  async act(request: TabRequest): Promise<TabActionResult> {
    const session = await this.ensureSession()
    const tab = String(request.tabId)
    await this.#run(['tab', 'borrow', tab, '--session', session])
    try {
      return await this.#dispatch(request, session)
    } finally {
      // Returning is best effort: the action's own result is what the caller
      // needs, and a tab the browser already navigated away from cannot be
      // returned at all.
      await this.#run(['tab', 'return', tab, '--session', session]).catch(() => '')
    }
  }

  /** Stop the session this instance started, if any. */
  async dispose(): Promise<void> {
    const session = this.#session
    this.#session = undefined
    if (session === undefined) return
    try {
      await this.#run(['session', 'stop', await session])
    } catch {
      // A session that never started has nothing to stop.
    }
  }

  /**
   * Start one session.
   * @returns its id.
   */
  async #start(): Promise<string> {
    const stdout = await this.#run([
      'session', 'start', '--json', '--no-focus', '--agent-name', this.#config.agentName,
    ])
    const parsed = JSON.parse(stdout) as { session_id?: unknown }
    if (typeof parsed.session_id !== 'string' || parsed.session_id === '') {
      throw new Error('bsk session start did not report a session_id')
    }
    return parsed.session_id
  }

  /**
   * Turn one request into the CLI's own argv, then run it.
   * @param request - the action to perform.
   * @param session - active session id.
   * @returns the action's output.
   */
  async #dispatch(request: TabRequest, session: string): Promise<TabActionResult> {
    const tail = ['--session', session]
    switch (request.action) {
      case 'observe':
      case 'snapshot':
        return { text: await this.#run([request.action, ...tail]) }
      case 'screenshot': {
        const path = join(tmpdir(), `dsh-browser-tab-${randomUUID()}.png`)
        return { text: await this.#run(['screenshot', '--out', path, ...tail]), path }
      }
      case 'navigate':
        return { text: await this.#run(['navigate', requireArg(request.target, 'target'), ...tail]) }
      case 'click':
        return { text: await this.#run(['click', requireArg(request.target, 'target'), ...tail]) }
      case 'fill':
        return {
          text: await this.#run([
            'fill', requireArg(request.target, 'target'), '--value', requireArg(request.value, 'value'), ...tail,
          ]),
        }
    }
  }

  /**
   * Run one command and answer its stdout.
   * @param args - argv after the executable.
   * @returns trimmed stdout.
   */
  #run(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#config.path,
        [...args],
        { timeout: this.#config.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null) {
            // `bsk` puts the actionable sentence (stale ref, unsupported flag,
            // no browser connected) on either stream; the model needs that
            // sentence, not `Command failed`.
            const detail = [stderr, stdout]
              .map(stream => typeof stream === 'string' ? stream.trim() : '')
              .filter(text => text !== '')
              .join('\n')
            reject(new Error(detail === '' ? error.message : detail))
            return
          }
          resolve(stdout.trim())
        },
      )
    })
  }
}

/**
 * Insist on an argument the action cannot work without.
 * @param value - the argument, if the caller supplied one.
 * @param name - what to call it in the refusal.
 * @returns the argument.
 */
function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`this action needs a non-empty ${name}`)
  }
  return value
}
