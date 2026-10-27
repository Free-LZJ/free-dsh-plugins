/**
 * The model-backed classifier: the same contract as the keyword one, answered by
 * an LLM instead of a word list.
 *
 * The shape of the call is copied from a **working plugin** in the host itself
 * (`dsh-session-title-llm`), not invented: `llm.prepareCall(route, signal, tweak)`
 * returns `{ config, stream }`, and the stream yields chunks whose text arrives as
 * `{ type: 'text-delta', text }`. That is the whole dependency — no agent, no
 * session, no tool loop, which is exactly why a classifier can use it.
 *
 * Two behaviours matter more than the model's quality:
 *
 * - **It never throws.** A classifier that fails must not fail the ingest; a
 *   timeout, a malformed answer, or a missing route all fall back to the
 *   deterministic keyword answer, and the card's reasons say which happened.
 * - **It never invents a kind.** The answer is validated against the same closed
 *   sets the rest of the board uses, and an unknown word becomes `unknown` with a
 *   low confidence — a hallucinated `kind` would route a card somewhere real.
 *
 * @module @free-lzj/dsh-console/workbench/llm-classifier
 */

import type { WorkbenchClassification, WorkbenchEvent, WorkbenchPriority } from '../protocol.ts'
import type { Classifier } from './classifier.ts'

/** The chunk vocabulary this module reads; everything else is ignored. */
export interface LlmChunkLike {
  readonly type?: string
  readonly text?: string
}

/** One prepared call: a fixed route plus a stream of chunks. */
export interface LlmCallLike {
  readonly config: Readonly<Record<string, unknown>>
  stream(options: Readonly<Record<string, unknown>>): AsyncIterable<LlmChunkLike>
}

/** The llm service verbs a classification needs; all verified against the host. */
export interface LlmPortLike {
  prepareCall(
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    tweak: (controls: Readonly<Record<string, unknown>>, model: unknown) => Readonly<Record<string, unknown>>,
  ): Promise<LlmCallLike>
}

/** Which model to ask, when the classifier is asked at all. */
export interface LlmRoute {
  readonly provider: string
  readonly model: string
}

/** What the classifier needs injected. */
export interface LlmClassifierOptions {
  readonly llm: LlmPortLike
  /** The route to ask; undefined means this deployment names no model. */
  readonly route: () => LlmRoute | undefined
  /** The keyword answer to fall back to, so a failure still classifies. */
  readonly fallback: Classifier
  /** How long one answer may take. */
  readonly timeoutMs?: number
}

/** Kinds and priorities the board understands; an answer outside them is rejected. */
const KINDS = ['bug', 'requirement', 'consult', 'unknown'] as const
const PRIORITIES: readonly WorkbenchPriority[] = ['urgent', 'high', 'normal', 'low']

/** The instruction sent with every event. */
const SYSTEM = [
  'You classify one inbound work item for a task board.',
  'Answer with one JSON object and nothing else:',
  '{"kind":"bug|requirement|consult|unknown","priority":"urgent|high|normal|low","confidence":0.0-1.0,"reason":"one short sentence"}',
  'Use "unknown" when the item really cannot be told apart, and a confidence below 0.5.',
].join('\n')

/**
 * A classifier that asks a model.
 *
 * Registered only when the deployment composes an `llm` service *and* names a
 * model; otherwise nothing is registered and the keyword classifier keeps
 * serving.
 */
export class LlmClassifier implements Classifier {
  readonly id = 'llm'

  /** @param options - the llm port, the route, and the fallback. */
  constructor(private readonly options: LlmClassifierOptions) {}

  /**
   * Classify one event, falling back to the deterministic answer on any failure.
   * @param event - the normalized inbound event.
   * @returns the classification, with a confidence and reasons.
   */
  async classify(event: WorkbenchEvent): Promise<WorkbenchClassification> {
    const route = this.options.route()
    if (route === undefined) return await this.declined(event, 'classify-llm-no-model')
    try {
      const answer = await this.ask(event, route)
      const parsed = parseAnswer(answer)
      if (parsed === undefined) return await this.declined(event, 'classify-llm-unreadable')
      return {
        kind: parsed.kind,
        priority: parsed.priority,
        confidence: parsed.confidence,
        reasons: [{
          code: 'classify-llm',
          params: { model: route.model, reason: parsed.reason },
        }],
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return await this.declined(event, 'classify-llm-failed', message)
    }
  }

  /** Ask the model and collect its text. */
  private async ask(event: WorkbenchEvent, route: LlmRoute): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, this.options.timeoutMs ?? 20_000)
    try {
      const call = await this.options.llm.prepareCall(
        { ...route, maxTokens: 200 },
        controller.signal,
        (controls) => controls,
      )
      const chunks = call.stream({
        ...call.config,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `${event.title}\n\n${event.body ?? ''}`.trim() }],
          source: { kind: 'dsh-console' },
        }],
        system: SYSTEM,
        purpose: 'console-classify',
        signal: controller.signal,
      })
      let text = ''
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta' && chunk.text !== undefined) text += chunk.text
      }
      return text
    } finally {
      clearTimeout(timeout)
    }
  }

  /** The deterministic answer, with the model's failure recorded as a reason. */
  private async declined(
    event: WorkbenchEvent,
    code: string,
    detail?: string,
  ): Promise<WorkbenchClassification> {
    const fallback = await this.options.fallback.classify(event)
    return {
      ...fallback,
      reasons: [
        { code, ...(detail === undefined ? {} : { params: { detail } }) },
        ...fallback.reasons,
      ],
    }
  }
}

/** One answer, validated against the board's own vocabulary. */
interface Answer {
  readonly kind: string
  readonly priority: WorkbenchPriority
  readonly confidence: number
  readonly reason: string
}

/**
 * Read one model answer.
 *
 * Models wrap JSON in prose and fences; the first balanced object is what matters.
 * Anything outside the board's vocabulary is **rejected** rather than coerced — a
 * `kind` of "performance bug" must not become `bug` by wishful mapping.
 * @param text - the model's answer.
 * @returns the validated answer, or undefined when it is not one.
 */
export function parseAnswer(text: string): Answer | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const kind = typeof record['kind'] === 'string' ? record['kind'].trim().toLowerCase() : ''
  const priority = typeof record['priority'] === 'string' ? record['priority'].trim().toLowerCase() : ''
  const confidence = typeof record['confidence'] === 'number' ? record['confidence'] : Number.NaN
  if (!(KINDS as readonly string[]).includes(kind)) return undefined
  if (!PRIORITIES.includes(priority as WorkbenchPriority)) return undefined
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined
  const reason = typeof record['reason'] === 'string' && record['reason'].trim() !== ''
    ? record['reason'].trim().slice(0, 120)
    : kind
  return { kind, priority: priority as WorkbenchPriority, confidence, reason }
}
/**
 * Read `provider/model` out of one configuration string.
 *
 * The route is a single string because that is how a user thinks about it; a
 * value without a slash names no model (rather than half a route).
 * @param value - the configured string.
 * @returns the route, or undefined when the string names none.
 */
export function modelRoute(value: string): LlmRoute | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}