/**
 * BrowserSkill's own MCP server, driven from the Host.
 *
 * Why not call the `bsk` CLI: a short-lived `bsk` cannot own a daemon inside a
 * desktop application. It tries to start one, the process inherits Electron's
 * outer Job Object, and `bsk` gives up ("still belongs to a Job Object after
 * breakaway"). A long-lived `bsk mcp` does work — it keeps the daemon as its own
 * child — which is also why the tools this plugin exposes to the model function
 * while a one-shot `bsk tab list` does not.
 *
 * So the mention menu speaks the same protocol the tools do: one `bsk mcp`
 * child, newline-delimited JSON-RPC, tools called by name.
 *
 * @module @free-lzj/dsh-browser-use/mcp-tabs
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserTab } from './protocol.ts'

/** How long one JSON-RPC round trip may take. */
const CALL_TIMEOUT_MS = 30_000

/** How long the server may take to answer `initialize`. */
const START_TIMEOUT_MS = 15_000

/** The MCP revision this client speaks; the server answers with its own. */
const PROTOCOL_VERSION = '2024-11-05'

/** One candidate executable, tried in order. */
function candidates(): readonly string[] {
  const override = process.env['DSH_BSK_PATH']
  if (override !== undefined && override !== '') return [override]
  // A desktop app does not inherit a terminal's PATH; BrowserSkill installs into
  // `~/.local/bin`, so that is the one extra place worth probing.
  return ['bsk', join(homedir(), '.local', 'bin', 'bsk.exe'), join(homedir(), '.local', 'bin', 'bsk')]
}

/**
 * Read one raw tab row into the shape the menu uses, or nothing.
 * @param value - one element of the server's `tabs` array.
 * @returns the tab, or undefined when the row cannot be described.
 */
function readTab(value: unknown): BrowserTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const tabId = row.tab_id
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return undefined
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const url = typeof row.url === 'string' ? row.url.trim() : ''
  if (title === '' && url === '') return undefined
  return { tabId, title: title === '' ? url : title, url, active: row.active === true }
}

/** One in-flight request. */
interface Pending {
  readonly resolve: (message: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * A minimal MCP stdio client, scoped to the two calls the menu needs.
 *
 * Deliberately not `@deepseek-ai/dsh-mcp-client`: that one exists to publish a
 * server's tools to an Agent, and the menu needs a private request/response
 * channel instead. Two children is the price of the two jobs being independent.
 */
export class BskMcpChannel {
  #child: ChildProcess | undefined
  #buffer = ''
  #seq = 1
  readonly #pending = new Map<number, Pending>()
  #session: string | undefined
  #starting: Promise<string> | undefined
  #disposed = false

  /**
   * Tabs in the user's own windows, most useful first.
   * @param signal - caller cancellation; a cancelled call stops waiting, not the server.
   * @returns the tabs, or none when the browser is unreachable.
   */
  async listUserTabs(signal: AbortSignal): Promise<readonly BrowserTab[]> {
    const session = await this.#ensureSession(signal)
    const answer = await this.#tool('bsk_tabs', { action: 'list', scope: 'user', session }, signal)
    const tabs = Array.isArray(answer.tabs) ? answer.tabs : []
    const parsed: BrowserTab[] = []
    for (const row of tabs) {
      const tab = readTab(row)
      if (tab !== undefined) parsed.push(tab)
    }
    // The tab the person is looking at is the one they most likely mean.
    return [...parsed.filter(tab => tab.active), ...parsed.filter(tab => !tab.active)]
  }

  /** Stop the child this channel owns. */
  dispose(): void {
    this.#disposed = true
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('browser-use: channel disposed'))
      this.#pending.delete(id)
    }
    this.#child?.kill()
    this.#child = undefined
  }

  /**
   * The session this channel drives, started on first use.
   * @param signal - caller cancellation while waiting for the start.
   * @returns the session id.
   */
  async #ensureSession(signal: AbortSignal): Promise<string> {
    if (this.#session !== undefined) return this.#session
    if (this.#starting === undefined) {
      const starting = this.#tool('bsk_session', { action: 'start', name: 'dsh-mention' }, signal)
        .then(answer => {
          if (typeof answer.session_id !== 'string' || answer.session_id === '') {
            throw new Error('browser-use: bsk_session start answered without a session_id')
          }
          this.#session = answer.session_id
          return answer.session_id
        })
      this.#starting = starting
      // A failed start must not be cached, or the next `@` never retries.
      starting.catch(() => {
        if (this.#starting === starting) this.#starting = undefined
      })
    }
    return this.#starting
  }

  /**
   * Call one MCP tool and parse its JSON answer.
   * @param name - tool name on the server.
   * @param args - tool arguments.
   * @param signal - caller cancellation.
   * @returns the parsed answer body.
   */
  async #tool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const message = await this.#request('tools/call', { name, arguments: args }, signal) as {
      result?: { content?: readonly { text?: unknown }[]; isError?: unknown }
      error?: unknown
    }
    if (message.error !== undefined) throw new Error(`browser-use: ${name} failed: ${JSON.stringify(message.error)}`)
    const text = message.result?.content?.map(part => typeof part.text === 'string' ? part.text : '').join('') ?? ''
    if (text === '') throw new Error(`browser-use: ${name} answered nothing`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`browser-use: ${name} answered non-JSON: ${text.slice(0, 200)}`)
    }
    if (typeof body !== 'object' || body === null) throw new Error(`browser-use: ${name} answered ${typeof body}`)
    const record = body as Record<string, unknown>
    // The server reports CLI-level failures inside the payload, with exit codes,
    // so a `bsk` problem surfaces as this plugin's own sentence.
    if (record['code'] !== null && record['code'] !== undefined) {
      throw new Error(`browser-use: ${name}: ${String(record['message'] ?? record['hint'] ?? record['code'])}`)
    }
    return record
  }

  /**
   * One JSON-RPC round trip, starting the child when needed.
   * @param method - JSON-RPC method.
   * @param params - method parameters.
   * @param signal - caller cancellation.
   * @returns the whole response message.
   */
  async #request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#disposed) throw new Error('browser-use: channel disposed')
    await this.#ensureChild(signal)
    const child = this.#child
    if (child === undefined || child.stdin === null) throw new Error('browser-use: bsk mcp is not running')
    const id = this.#seq
    this.#seq += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`browser-use: ${method} timed out after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error('browser-use: request cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        resolve: message => {
          signal.removeEventListener('abort', onAbort)
          resolve(message)
        },
        reject: error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /**
   * Start the server and complete the handshake, once.
   * @param signal - caller cancellation while starting.
   */
  async #ensureChild(signal: AbortSignal): Promise<void> {
    if (this.#child !== undefined) return
    const child = await this.#spawn(signal)
    this.#child = child
    child.stdout?.on('data', (chunk: Buffer) => { this.#feed(chunk.toString('utf8')) })
    // A server that exits takes every in-flight request with it; the next `@`
    // starts a fresh one rather than waiting on a dead pipe.
    child.on('exit', () => {
      if (this.#child === child) this.#child = undefined
      this.#rejectAll('browser-use: bsk mcp exited')
    })
    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-browser-use', version: '0' },
    }, signal)
  }

  /**
   * Spawn the first candidate executable that exists.
   * @param signal - caller cancellation while spawning.
   * @returns the live child.
   */
  async #spawn(signal: AbortSignal): Promise<ChildProcess> {
    let missing: Error | undefined
    for (const command of candidates()) {
      const child = spawn(command, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const spawned = await new Promise<boolean>(resolve => {
        const onError = (error: NodeJS.ErrnoException): void => {
          child.removeListener('spawn', onSpawn)
          missing = error
          resolve(false)
        }
        const onSpawn = (): void => {
          child.removeListener('error', onError)
          resolve(true)
        }
        child.once('error', onError)
        child.once('spawn', onSpawn)
        signal.addEventListener('abort', () => resolve(false), { once: true })
        setTimeout(() => resolve(child.pid !== undefined), START_TIMEOUT_MS)
      })
      if (spawned && child.pid !== undefined) return child
      child.kill()
    }
    throw missing ?? new Error('browser-use: could not start `bsk mcp`; is BrowserSkill installed?')
  }

  /**
   * Parse one stdout chunk into responses.
   * @param chunk - the text that arrived.
   */
  #feed(chunk: string): void {
    this.#buffer += chunk
    for (;;) {
      const at = this.#buffer.indexOf('\n')
      if (at < 0) return
      const line = this.#buffer.slice(0, at).trim()
      this.#buffer = this.#buffer.slice(at + 1)
      if (line === '') continue
      let message: { id?: unknown }
      try {
        message = JSON.parse(line) as { id?: unknown }
      } catch {
        // Servers may log freely on stdout; a non-JSON line is not a response.
        continue
      }
      const id = message.id
      if (typeof id !== 'number') continue
      const pending = this.#pending.get(id)
      if (pending === undefined) continue
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.resolve(message)
    }
  }

  /**
   * Fail every in-flight request.
   * @param message - the failure sentence.
   */
  #rejectAll(message: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.#pending.delete(id)
    }
  }
}
