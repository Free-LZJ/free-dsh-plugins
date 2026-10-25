/**
 * The board: the workbench's orchestration, and nothing else.
 *
 * One class owns the flow the design brief describes — an event arrives, the
 * classifier judges it, the routing table decides, a card appears, a dispatch
 * starts a session, the session's end moves the card — because every step
 * writes the same audit trail onto the card, and a trail split across modules
 * is a trail that diverges.
 *
 * The board knows no implementation names: classifiers, executors, and
 * connectors arrive as registries, and the routing table arrives as a store.
 * Adding an executor, a classifier, or a connector is a registration at
 * assembly, never an edit here. Two boundaries are load-bearing and stated
 * wherever they bite:
 *
 * - **No automatic write-back.** A finished card lands in `done` with
 *   `awaitingConfirmation` set; nothing in this file calls an outbound
 *   connector, and the placeholder connectors send no real request either.
 * - **No diff review gate.** The user shelved it for v0, so `done` means the
 *   run finished, not that a human approved a diff.
 *
 * @module @free-lzj/dsh-console/workbench/board
 */

import { randomUUID } from 'node:crypto'
import type {
  RoutingDecision, WorkbenchCard, WorkbenchColumn, WorkbenchConnectorInfo,
  WorkbenchEvent, WorkbenchSession, WorkbenchState,
} from '../protocol.ts'
import { defaultRoutingTable, routeEvent, type RoutingTableStore } from './routing.ts'
import { ClassifierRegistry, RULE_CLASSIFIER_ID } from './classifier.ts'
import { ExecutorRegistry, type ExecutorHandle } from './executors.ts'
import { ConnectorRegistry } from './connectors.ts'
import { SessionStore } from './sessions.ts'
import { readWorkbench, writeWorkbench } from './store.ts'

/** What ingesting one event produced. */
export type IngestResult =
  | { readonly ok: true; readonly card: WorkbenchCard; readonly duplicate: boolean; readonly decision: RoutingDecision }
  | { readonly ok: false; readonly error: string }

/** What one board action produced. */
export interface ActionResult {
  readonly ok: boolean
  readonly card?: WorkbenchCard
  readonly session?: WorkbenchSession
  readonly error?: string
}

/** Everything the board needs from its owner, injected so tests drive it without files. */
export interface WorkbenchBoardOptions {
  /** The harness home directory the board document lives below; undefined means memory only. */
  readonly homeDir?: string
  readonly classifiers: ClassifierRegistry
  readonly executors: ExecutorRegistry
  readonly connectors: ConnectorRegistry
  readonly routing: RoutingTableStore
  /** Connector ids the saved configuration switches on. */
  readonly enabledConnectors: () => readonly string[]
  /** Classifier id the saved configuration selects. */
  readonly classifierId: () => string
  /** Where a rejected configuration or a failed write is reported. */
  readonly warn: (message: string) => void
}

/**
 * The board.
 *
 * Cards and sessions live in memory and are persisted best-effort; a failed
 * write warns and the in-memory board keeps serving, because a board that
 * refuses an event over a disk error has its priorities backwards.
 */
export class WorkbenchBoard {
  private readonly cards = new Map<string, WorkbenchCard>()
  private readonly dedupe = new Map<string, string>()
  private readonly sessions = new SessionStore()
  private readonly handles = new Map<string, ExecutorHandle>()
  private readonly listeners = new Set<(state: WorkbenchState) => void>()
  private readonly warnedUnknownConnectors = new Set<string>()
  private routingVersion = defaultRoutingTable().version
  private revision = 0
  /** The write chain every bump appends to, so bursts serialize instead of racing. */
  private pendingWrite: Promise<void> = Promise.resolve()
  /** Settles once the saved document was read (or found absent). */
  readonly ready: Promise<void>

  /**
   * @param options - the registries, the routing store, and the live configuration readers.
   */
  constructor(private readonly options: WorkbenchBoardOptions) {
    this.ready = this.load()
  }

  /**
   * Ingest one event: dedupe, classify, route, and — when routing says so —
   * dispatch.
   * @param event - the normalized inbound event.
   * @returns the card and the decision, or why the event was refused.
   */
  async ingest(event: WorkbenchEvent): Promise<IngestResult> {
    const title = typeof event?.title === 'string' ? event.title.trim() : ''
    if (title === '') return { ok: false, error: 'an event needs a non-empty title' }
    const source = event.source
    const normalized: WorkbenchEvent = {
      source,
      ...(event.externalId === undefined ? {} : { externalId: event.externalId }),
      title,
      ...(event.body === undefined ? {} : { body: event.body }),
    }
    const dedupeKey = normalized.externalId !== undefined
      ? `${source}:${normalized.externalId}`
      : `${source}:title:${title}`
    const existingId = this.dedupe.get(dedupeKey)
    if (existingId !== undefined) {
      // Import is read-only and deduped: a repeated delivery never builds a
      // second card, and never touches the source system.
      const existing = this.cards.get(existingId)
      if (existing !== undefined) return { ok: true, card: existing, duplicate: true, decision: existing.decision }
    }

    const classifier = this.options.classifiers.get(this.options.classifierId())
      ?? this.options.classifiers.get(RULE_CLASSIFIER_ID)
    if (classifier === undefined) return { ok: false, error: 'no classifier is registered' }
    if (this.options.classifiers.get(this.options.classifierId()) === undefined) {
      this.options.warn(`workbench: unknown classifier "${this.options.classifierId()}", falling back to "${RULE_CLASSIFIER_ID}"`)
    }
    const classification = await classifier.classify(normalized)
    const table = await this.options.routing.current()
    this.routingVersion = table.version
    let decision = routeEvent(classification, table, source)

    const now = Date.now()
    let card: WorkbenchCard = {
      id: randomUUID(),
      source,
      ...(normalized.externalId === undefined ? {} : { externalId: normalized.externalId }),
      dedupeKey,
      title,
      ...(normalized.body === undefined ? {} : { body: normalized.body }),
      column: decision.action === 'dispatch' ? 'processing' : 'todo',
      status: decision.action === 'dispatch' ? 'running' : 'idle',
      priority: classification.priority,
      kind: classification.kind,
      confidence: classification.confidence,
      ...(decision.executor === undefined ? {} : { executor: decision.executor }),
      awaitingConfirmation: false,
      createdAt: now,
      updatedAt: now,
      decision,
    }

    // The card lands in the map before its session starts, so a log line the
    // executor writes synchronously never describes a card the board lacks.
    this.cards.set(card.id, card)
    this.dedupe.set(dedupeKey, card.id)

    if (decision.action === 'dispatch') {
      const executorId = decision.executor ?? 'dsh'
      if (this.options.executors.get(executorId) === undefined) {
        // An executor id routing names but nobody registered is a hold with a
        // reason, never a crash and never a dispatch to the wrong agent.
        decision = {
          ...decision,
          action: 'hold',
          routeId: 'unknown-executor',
          reasons: [...decision.reasons, `路由指定的执行器 ${executorId} 未注册，落入待办人工处理`],
        }
        card = { ...card, column: 'todo', status: 'idle', decision }
        this.cards.set(card.id, card)
      } else {
        card = this.startSession(card, executorId)
        this.cards.set(card.id, card)
      }
    }

    this.bump()
    return { ok: true, card: this.cards.get(card.id) as WorkbenchCard, duplicate: false, decision }
  }

  /**
   * Dispatch one card manually — the drag-or-button path for a card routing
   * held, or one a human wants started now.
   * @param cardId - the card.
   * @param executorId - the executor, or the card's suggestion when absent.
   * @returns the card and its session, or why it cannot start.
   */
  dispatch(cardId: string, executorId?: string): ActionResult {
    const card = this.cards.get(cardId)
    if (card === undefined) return { ok: false, error: `unknown card "${cardId}"` }
    if (card.column === 'processing') {
      const session = card.sessionId === undefined ? undefined : this.sessions.get(card.sessionId)
      return { ok: true, card, ...(session === undefined ? {} : { session }) }
    }
    const id = executorId ?? card.executor ?? card.decision.executor ?? 'dsh'
    if (this.options.executors.get(id) === undefined) {
      return { ok: false, error: `unknown executor "${id}"` }
    }
    const started = this.startSession({ ...card, column: 'processing', status: 'running' }, id)
    this.cards.set(started.id, started)
    this.bump()
    const startedSession = started.sessionId === undefined ? undefined : this.sessions.get(started.sessionId)
    return {
      ok: true,
      card: started,
      ...(startedSession === undefined ? {} : { session: startedSession }),
    }
  }

  /**
   * Move one card between columns, driving its session with it: into
   * `processing` starts or resumes the run, into `todo` pauses it, into
   * `done` ends it.
   * @param cardId - the card.
   * @param column - the destination column.
   * @returns the card, or why it cannot move.
   */
  move(cardId: string, column: WorkbenchColumn): ActionResult {
    const card = this.cards.get(cardId)
    if (card === undefined) return { ok: false, error: `unknown card "${cardId}"` }
    if (card.column === column) return { ok: true, card }
    if (column === 'processing') return this.dispatch(cardId)
    if (column === 'done') {
      if (card.sessionId !== undefined) this.endSessionInternal(card.sessionId, false)
      const done: WorkbenchCard = {
        ...card,
        column: 'done',
        status: 'done',
        awaitingConfirmation: true,
        updatedAt: Date.now(),
      }
      this.cards.set(done.id, done)
      this.bump()
      return { ok: true, card: done }
    }
    // Into `todo`: a running run pauses rather than vanishing.
    if (card.sessionId !== undefined) this.pauseSessionInternal(card.sessionId)
    const todo: WorkbenchCard = {
      ...card,
      column: 'todo',
      status: card.sessionId === undefined ? 'idle' : 'paused',
      updatedAt: Date.now(),
    }
    this.cards.set(todo.id, todo)
    this.bump()
    return { ok: true, card: todo }
  }

  /**
   * Send a follow-up message into a session.
   * @param sessionId - the session.
   * @param text - the message.
   * @returns the session, or why it cannot take the message.
   */
  interrupt(sessionId: string, text: string): ActionResult {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: `unknown session "${sessionId}"` }
    if (text.trim() === '') return { ok: false, error: 'an interrupt needs non-empty text' }
    const handle = this.handles.get(sessionId)
    if (handle === undefined || session.status === 'done' || session.status === 'failed' || session.status === 'ended') {
      return { ok: false, error: 'this session no longer accepts messages' }
    }
    handle.interrupt(text.trim())
    this.bump()
    return this.sessionResult(sessionId)
  }

  /**
   * Pause a session.
   * @param sessionId - the session.
   * @returns the session, or why it cannot pause.
   */
  pauseSession(sessionId: string): ActionResult {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: `unknown session "${sessionId}"` }
    if (session.status !== 'running') return { ok: true, session }
    this.pauseSessionInternal(sessionId)
    this.bump()
    return this.sessionResult(sessionId)
  }

  /**
   * Resume a paused session.
   * @param sessionId - the session.
   * @returns the session, or why it cannot resume.
   */
  resumeSession(sessionId: string): ActionResult {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: `unknown session "${sessionId}"` }
    if (session.status !== 'paused') return { ok: true, session }
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return { ok: false, error: 'this session has no live run to resume' }
    handle.resume()
    this.sessions.setStatus(sessionId, 'running')
    const card = this.cards.get(session.cardId)
    if (card !== undefined && card.column === 'processing') {
      this.cards.set(card.id, { ...card, status: 'running', updatedAt: Date.now() })
    }
    this.bump()
    return this.sessionResult(sessionId)
  }

  /**
   * End a session: the run stops and the card returns to `todo` for a human
   * to decide what happens next.
   * @param sessionId - the session.
   * @returns the session, or why it cannot end.
   */
  endSession(sessionId: string): ActionResult {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: `unknown session "${sessionId}"` }
    if (session.status === 'ended' || session.status === 'done' || session.status === 'failed') {
      return { ok: true, session }
    }
    this.endSessionInternal(sessionId, true)
    this.bump()
    return this.sessionResult(sessionId)
  }

  /** Read the whole board state. */
  state(): WorkbenchState {
    return {
      cards: [...this.cards.values()].sort((a, b) => a.createdAt - b.createdAt),
      sessions: this.sessions.list(),
      connectors: this.connectorInfos(),
      routingVersion: this.routingVersion,
      revision: this.revision,
    }
  }

  /**
   * Subscribe to board changes.
   * @param listener - receives the new state; called synchronously.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (state: WorkbenchState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Load the persisted document, if the board persists at all. */
  private async load(): Promise<void> {
    if (this.options.homeDir === undefined) return
    const document = await readWorkbench(this.options.homeDir)
    for (const card of document.cards) {
      this.cards.set(card.id, card)
      this.dedupe.set(card.dedupeKey, card.id)
    }
    this.sessions.restore(document.sessions)
  }

  /**
   * Start a session for a card and wire the executor's sink to the board.
   * @param card - the card, already placed in `processing`.
   * @param executorId - the executor to run.
   * @returns the card with its session attached.
   */
  private startSession(card: WorkbenchCard, executorId: string): WorkbenchCard {
    const executor = this.options.executors.get(executorId)
    if (executor === undefined) throw new Error(`workbench: executor "${executorId}" is not registered`)
    const session = this.sessions.create(card.id, executorId)
    const handle = executor.dispatch(card, {
      log: (text) => {
        this.sessions.appendLog(session.id, text)
        this.bump()
      },
      finish: (status) => {
        this.handles.delete(session.id)
        this.sessions.setStatus(session.id, status)
        const current = this.cards.get(card.id)
        if (current !== undefined && current.column === 'processing') {
          const finished: WorkbenchCard = {
            ...current,
            column: status === 'done' ? 'done' : current.column,
            status: status === 'done' ? 'done' : 'failed',
            awaitingConfirmation: status === 'done',
            updatedAt: Date.now(),
          }
          this.cards.set(finished.id, finished)
        }
        this.bump()
      },
    })
    this.handles.set(session.id, handle)
    return { ...card, sessionId: session.id }
  }

  /**
   * Re-read a session after a mutation, so the answer carries the fresh log
   * and status rather than the object the mutation started from.
   * @param sessionId - the session.
   * @returns the session, or why it vanished.
   */
  private sessionResult(sessionId: string): ActionResult {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: `unknown session "${sessionId}"` }
    return { ok: true, session }
  }

  /** Pause a session and its card, without a state push (the caller bumps). */
  private pauseSessionInternal(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.status !== 'running') return
    this.handles.get(sessionId)?.pause()
    this.sessions.setStatus(sessionId, 'paused')
    const card = this.cards.get(session.cardId)
    if (card !== undefined && card.column === 'processing') {
      this.cards.set(card.id, { ...card, status: 'paused', updatedAt: Date.now() })
    }
  }

  /**
   * End a session: stop the run, mark the session ended, and return its card
   * to `todo` when it was still processing.
   * @param sessionId - the session.
   * @param markCard - whether the card moves back to `todo` (a manual end does;
   *   a move-to-`done` already placed the card and must not pull it back).
   */
  private endSessionInternal(sessionId: string, markCard: boolean): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.handles.get(sessionId)?.end()
    this.handles.delete(sessionId)
    this.sessions.setStatus(sessionId, 'ended')
    if (!markCard) return
    const card = this.cards.get(session.cardId)
    if (card !== undefined && card.column === 'processing') {
      this.cards.set(card.id, { ...card, column: 'todo', status: 'idle', updatedAt: Date.now() })
    }
  }

  /** Connectors joined with the saved configuration; unknown ids warn once and drop. */
  private connectorInfos(): WorkbenchConnectorInfo[] {
    const enabled = this.options.enabledConnectors()
    for (const id of enabled) {
      if (this.options.connectors.get(id) === undefined && !this.warnedUnknownConnectors.has(id)) {
        this.warnedUnknownConnectors.add(id)
        this.options.warn(`workbench: ignoring unknown connector "${id}"`)
      }
    }
    return this.options.connectors.list().map((connector) => ({
      id: connector.id,
      label: connector.label,
      directions: connector.directions,
      enabled: enabled.includes(connector.id),
      implemented: connector.implemented,
      ...(connector.note === undefined ? {} : { note: connector.note }),
    }))
  }

  /**
   * Wait for every queued board write to land.
   *
   * Production never needs it — a later bump always supersedes an earlier
   * snapshot — but a test that reloads the board must know the document it
   * reads is the latest one, not a write still in flight.
   * @returns a promise settling when the queue drains.
   */
  flush(): Promise<void> {
    return this.pendingWrite
  }

  /** Advance the revision, persist best-effort, and push the new state. */
  private bump(): void {
    this.revision += 1
    if (this.options.homeDir !== undefined) {
      // Serialized, not concurrent: each write captures the snapshot of its
      // own bump, and the chain keeps the last write the newest snapshot
      // instead of whichever rename happened to win a race.
      const home = this.options.homeDir
      const document = {
        version: 1,
        cards: [...this.cards.values()],
        sessions: this.sessions.list(),
      }
      this.pendingWrite = this.pendingWrite
        .then(() => writeWorkbench(home, document))
        .catch((error: unknown) => {
          this.options.warn(`workbench: saving board failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }
    const state = this.state()
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error: unknown) {
        this.options.warn(`workbench: event listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
