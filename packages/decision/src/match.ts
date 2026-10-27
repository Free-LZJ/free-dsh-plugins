/**
 * Rule matching, in the kernel: "do all of this rule's conditions hold?"
 *
 * Three things make this worth moving out of a connector even though it is short:
 *
 * - **The lazy body read is generic.** A body fetch is the expensive step on every
 *   connector, and the rule that decides whether it is needed belongs to the condition
 *   (`needsBody` / `needsBodyFor`), not to the caller. Getting this wrong costs one
 *   round trip per rule.
 * - **One unmatched condition ends the rule, and the reason is logged.** A rule that
 *   uses a condition kind this deployment does not have is a *configuration* answer,
 *   not a silent "no".
 * - **The context is built per condition**, so a connector can attach its own ports
 *   (a classifier, a cache) without the kernel knowing what they mean.
 *
 * @module @free-lzj/dsh-decision/match
 */

import type { ConditionRegistry, ConditionSpecLike } from './registry.ts'

/** What a matching pass carries between conditions. */
export interface MatchState {
  /** Fetched lazily, once per pass, and only when a condition asks for it. */
  body?: string
}

/** Everything one matching pass needs from the connector. */
export interface MatchPlan<TSpec extends ConditionSpecLike, TContext, TKind extends string> {
  readonly conditions: ConditionRegistry<TSpec, TContext, TKind>
  /** Build the context for one condition; `state` is the same object across the pass. */
  readonly context: (state: MatchState) => TContext
  /** Fetch the body; called at most once per pass. */
  readonly readBody: () => Promise<string>
  /** One line when a rule cannot be evaluated at all. */
  readonly log: (line: string) => void
}

/**
 * Check every condition of one rule.
 *
 * Short-circuits on the first condition that does not hold — a rule with four conditions
 * should not pay for the body when the first one already said no.
 * @param rule - the rule to evaluate; only `name` and `when` are read.
 * @param plan - the condition registry and the connector's context builder.
 * @returns true when every condition held.
 */
export async function ruleMatches<TSpec extends ConditionSpecLike, TContext, TKind extends string>(
  rule: { readonly name: string; readonly when: readonly (TSpec & { readonly kind: TKind })[] },
  plan: MatchPlan<TSpec, TContext, TKind>,
): Promise<boolean> {
  const state: MatchState = {}
  for (const spec of rule.when) {
    const condition = plan.conditions.get(spec.kind)
    if (condition === undefined) {
      plan.log(`规则「${rule.name}」用了本部署没有的条件 ${String(spec.kind)}，判为不命中`)
      return false
    }
    // 正文只在该条件**真的**用得上时才取：`needsBody` 是「总是要」，
    // `needsBodyFor` 是「看配置」。
    if ((condition.needsBody || condition.needsBodyFor?.(spec) === true) && state.body === undefined) {
      state.body = await plan.readBody()
    }
    const matched = await condition.test(spec, plan.context(state))
    if (!matched) return false
  }
  return true
}
