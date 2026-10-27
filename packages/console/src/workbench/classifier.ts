/**
 * The classification core: the judgement half of the workbench's rules.
 *
 * The design brief splits rules into a deterministic shell and a judgement
 * core: hard rules and the routing table decide *what happens*, this module
 * decides *what an event is*. The core is a strategy plus a registry
 * (`rules/design-patterns.md`): the contract below names no implementation,
 * the kernel never names one either, and the configuration picks which
 * registered classifier runs. A model-backed classifier is a later
 * implementation of the same interface — it must return the same shape, with
 * a confidence and reasons, so swapping it in changes no routing code.
 *
 * What ships in v0 is the deterministic fallback: keyword scoring over the
 * title and body. It is deliberately conservative — an event that matches
 * nothing, or matches two kinds equally, comes back `unknown` with a low
 * confidence, and routing holds such cards for a human instead of guessing.
 *
 * @module @free-lzj/dsh-console/workbench/classifier
 */

import type { WorkbenchClassification, WorkbenchEvent, WorkbenchPriority } from '../protocol.ts'

/**
 * One classifier implementation.
 *
 * The interface carries no configuration and reads no environment: what it
 * needs arrives in the event, and what it decides leaves in the result.
 */
export interface Classifier {
  /** Stable id the configuration selects by. */
  readonly id: string
  /**
   * Classify one event.
   * @param event - the normalized inbound event.
   * @returns the classification, with a confidence and reasons.
   */
  classify(event: WorkbenchEvent): Promise<WorkbenchClassification> | WorkbenchClassification
}

/**
 * The registry the board consults.
 *
 * Implementations register at assembly; the board looks one up by id and
 * never enumerates implementation names. Adding a classifier is adding a
 * registration, not editing the board.
 */
export class ClassifierRegistry {
  private readonly classifiers = new Map<string, Classifier>()

  /**
   * Register one implementation.
   * @param classifier - the implementation.
   * @returns the unregister function.
   */
  register(classifier: Classifier): () => void {
    this.classifiers.set(classifier.id, classifier)
    return () => {
      if (this.classifiers.get(classifier.id) === classifier) this.classifiers.delete(classifier.id)
    }
  }

  /** @param id - classifier id. @returns the implementation, or undefined. */
  get(id: string): Classifier | undefined {
    return this.classifiers.get(id)
  }

  /** @returns every registered implementation, in registration order. */
  list(): Classifier[] {
    return [...this.classifiers.values()]
  }
}

/** The id the configuration selects when it names no classifier. */
export const RULE_CLASSIFIER_ID = 'rule'

/** Keyword groups the fallback scores, in the order ties are broken. */
const KIND_KEYWORDS: readonly { readonly kind: string; readonly words: readonly string[] }[] = [
  { kind: 'bug', words: ['崩溃', '闪退', '报错', '异常', '失败', '无法', '错误', '故障', 'bug', '修复', '挂了', '打不开'] },
  { kind: 'requirement', words: ['需求', '新增', '希望', '支持', '功能', '优化', '改进', '加上'] },
  { kind: 'consult', words: ['咨询', '请问', '怎么', '如何', '为什么', '文档', '说明', '求助'] },
]

/** Words that raise the priority above `normal`. */
const URGENT_WORDS = ['线上', '紧急', '阻塞', '生产', 'p0', '严重', '立刻', '马上']
const HIGH_WORDS = ['重要', '尽快', '优先']

/** A Jira-style key the fallback can read a project off, e.g. `EXEPD-222269`. */
const PROJECT_PATTERN = /([A-Z]+)-\d+/

/** The executor a kind suggests when the classification has an opinion. */
const KIND_EXECUTOR: Readonly<Record<string, string>> = { bug: 'dsh', requirement: 'codex' }

/**
 * The deterministic fallback classifier.
 *
 * Scores each kind by distinct keyword hits in `title + body`; the winner
 * takes the kind, the margin takes the confidence. No hits, or a tie at the
 * top, is `unknown` — routing treats that as "ask a human", never as a
 * dispatch.
 */
export class RuleClassifier implements Classifier {
  readonly id = RULE_CLASSIFIER_ID

  classify(event: WorkbenchEvent): WorkbenchClassification {
    const text = `${event.title}\n${event.body ?? ''}`
    const lower = text.toLowerCase()
    const scores = KIND_KEYWORDS.map(({ kind, words }) => ({
      kind,
      hits: words.filter((word) => lower.includes(word.toLowerCase())).length,
    }))
    const ranked = [...scores].sort((a, b) => b.hits - a.hits)
    const top = ranked[0]
    const second = ranked[1]
    const project = PROJECT_PATTERN.exec(text)?.[1]

    const priority: WorkbenchPriority = URGENT_WORDS.some((word) => lower.includes(word))
      ? 'urgent'
      : HIGH_WORDS.some((word) => lower.includes(word))
        ? 'high'
        : 'normal'

    if (top === undefined || top.hits === 0) {
      return {
        kind: 'unknown',
        ...(project === undefined ? {} : { project }),
        priority,
        confidence: 0.3,
        reasons: [{ code: 'classify-none' }],
      }
    }
    if (second !== undefined && second.hits === top.hits) {
      return {
        kind: 'unknown',
        ...(project === undefined ? {} : { project }),
        priority,
        confidence: 0.45,
        reasons: [{ code: 'classify-ambiguous', params: { first: top.kind, second: second.kind } }],
      }
    }
    const executor = KIND_EXECUTOR[top.kind]
    return {
      kind: top.kind,
      ...(project === undefined ? {} : { project }),
      priority,
      ...(executor === undefined ? {} : { executor }),
      // One hit is a hint, more hits are corroboration; never full certainty.
      confidence: Math.min(0.95, 0.6 + 0.1 * (top.hits - 1)),
      reasons: [{ code: 'classify-keyword-hit', params: { kind: top.kind, count: top.hits } }],
    }
  }
}
