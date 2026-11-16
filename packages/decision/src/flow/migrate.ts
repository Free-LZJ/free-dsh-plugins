/**
 * 把旧的规则列表转成节点图。
 *
 * 这是一次性的迁移逻辑，但它放在库里而不是脚本里：**转换对不对要能测**。跑完那次迁移
 * 之后这个文件就可以删，`rules.yml` 从此只有一种形状。
 *
 * 转换的形状：
 *
 * ```
 *          ┌─[rule 0 的 when]→ 动作… → end-0
 * start → switch ─[rule 1 的 when]→ 动作… → end-1
 *          └─[兜底]────────────→ end-rest
 * ```
 *
 * 每条规则**自己的 end**，不共用一个收尾节点：共用会让多条分支汇到一点，图上看不出
 * 谁是谁，也容易误用汇合语义。
 *
 * `classifier` 条件保持原样。它在图里不再是「条件自己调模型」——`classify` 节点先跑一次，
 * 把结果写进 `facts`，条件读到就不再问第二次。
 *
 * @module @free-lzj/dsh-decision/flow/migrate
 */

import type { ConditionSpecLike } from '../registry.ts'
import type { ActionSpecLike } from '../registry.ts'
import type { Rule } from '../types.ts'
import type { Flow, FlowEdgeSpec, FlowNodeSpec } from './types.ts'

/** 迁移参数。 */
export interface MigrateOptions {
  /** 归属连接器；写进 flow 的 `connector`。 */
  readonly connector: string
  readonly flowId?: string
  readonly flowName?: string
  /** 触发器订阅什么事件；缺省 `mail.received`。 */
  readonly event?: string
}

/** 一条 `classifier` 条件里能被合并的东西。 */
interface ClassifierSpec {
  readonly labels?: readonly string[]
  readonly prompt?: string
}

/** 从条件里收出分类节点的配置。 */
function collectClassifier(rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[]): { labels: readonly string[]; prompt?: string } | undefined {
  const labels: string[] = []
  const notes: string[] = []
  for (const rule of rules) {
    for (const condition of rule.when) {
      if (condition.kind !== 'classifier') continue
      const spec = condition as ClassifierSpec
      for (const label of spec.labels ?? []) {
        if (!labels.includes(label)) labels.push(label)
      }
      const note = typeof spec.prompt === 'string' ? spec.prompt.trim() : ''
      if (note !== '' && !notes.includes(note)) notes.push(note)
    }
  }
  if (labels.length === 0) return undefined
  return notes.length === 0 ? { labels } : { labels, prompt: notes.join('\n\n') }
}

/**
 * 生成节点 id：规则 id 可能带连字符与中文，统一加前缀避免撞上内置类型名。
 * @param ruleId - 规则 id。
 * @param suffix - 后缀。
 * @returns 节点 id。
 */
function nodeId(ruleId: string, suffix: string): string {
  return `${ruleId}__${suffix}`
}

/**
 * 把规则列表转成一张图。
 *
 * 规则顺序即 `switch` 出边的顺序；最后一条无条件出边是兜底，与旧语义「首命中、否则
 * 落到下一个」一致。
 * @param rules - 已按 priority 升序、只含启用规则的列表。
 * @param options - 归属连接器与图的名字。
 * @returns 图。
 */
export function migrateRulesToFlow(
  rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[],
  options: MigrateOptions,
): Flow {
  const usable = rules.filter(rule => rule.enabled && rule.then.length > 0)
  const classifier = collectClassifier(usable)

  const nodes: FlowNodeSpec[] = []
  const startId = 'start'
  const routeId = 'route'
  const classifyId = 'classify'

  nodes.push({
    id: startId,
    type: 'trigger',
    config: { event: 'mail.received' },
    out: [{ to: classifier === undefined ? routeId : classifyId }],
  })

  if (classifier !== undefined) {
    nodes.push({
      id: classifyId,
      type: 'classify',
      config: { ...classifier },
      out: [{ to: routeId }],
    })
  }

  const routeEdges: FlowEdgeSpec[] = []
  for (const rule of usable) {
    const firstAction = nodeId(rule.id, '0')
    routeEdges.push({
      to: firstAction,
      ...(rule.when.length === 0 ? {} : { when: rule.when }),
    })
    // 动作按 then 的顺序串起来；最后一个接到这条规则自己的 end。
    rule.then.forEach((action, index) => {
      const id = nodeId(rule.id, String(index))
      const nextId = index === rule.then.length - 1
        ? nodeId(rule.id, 'end')
        : nodeId(rule.id, String(index + 1))
      nodes.push({
        id,
        type: action.kind,
        config: { ...action },
        ...(nextId === nodeId(rule.id, 'end') ? { out: [{ to: nextId }] } : { out: [{ to: nextId }] }),
      })
    })
    nodes.push({ id: nodeId(rule.id, 'end'), type: 'end' })
  }

  nodes.push({ id: routeId, type: 'switch', out: routeEdges })
  nodes.push({ id: 'rest', type: 'end' })
  // switch 一条都不中时落到 rest：给它一条无条件出边（switch 会把它当兜底）。
  const routeNode = nodes.find(node => node.id === routeId)
  if (routeNode !== undefined) {
    nodes[nodes.indexOf(routeNode)] = {
      ...routeNode,
      out: [...routeEdges, { to: 'rest' }],
    }
  }

  return {
    id: options.flowId ?? 'mail-triage',
    name: options.flowName ?? '邮件自动化',
    connector: options.connector,
    nodes,
  }
}

/**
 * 一条规则拆成一张独立的图。
 *
 * 形状比合集版简单，因为**只有一条分支**：
 *
 * ```text
 * start(trigger) → route(switch) ─[这条规则的 when]→ 动作… → end-hit
 *                               └─[兜底]──────────→ end-miss
 * ```
 *
 * 保留了 switch 而不是展开成 `if`：它和合集版同构，迁移前后的读图习惯不用改；将来
 * 想在文件里再加一条分支，直接给 switch 添一条出边就行。
 * @param rule - 一条旧规则。
 * @param options - 归属连接器与 id 前缀。
 * @returns 只含这一条规则的图。
 */
export function migrateRuleToFlow(
  rule: Rule<ConditionSpecLike, ActionSpecLike>,
  options: MigrateOptions,
): Flow {
  const startId = 'trigger'
  const routeId = 'branch'
  const hitId = 'end-hit'
  const missId = 'end-miss'

  const nodes: FlowNodeSpec[] = [{
    id: startId,
    type: 'trigger',
    config: { event: options.event ?? 'mail.received' },
    out: [{ to: routeId }],
  }]

  // 动作按 `then` 的顺序串起来，最后一个接这条规则的收尾。
  rule.then.forEach((action, index) => {
    const id = nodeId(rule.id, String(index))
    const nextId = index === rule.then.length - 1 ? hitId : nodeId(rule.id, String(index + 1))
    nodes.push({
      id,
      type: action.kind,
      config: { ...action },
      out: [{ to: nextId }],
    })
  })

  nodes.push({
    id: routeId,
    type: 'switch',
    out: [
      {
        to: rule.then.length === 0 ? hitId : nodeId(rule.id, '0'),
        ...(rule.when.length === 0 ? {} : { when: rule.when }),
      },
      { to: missId },
    ],
  })
  nodes.push({ id: hitId, type: 'end' })
  nodes.push({ id: missId, type: 'end' })

  return {
    id: options.flowId ?? rule.id,
    name: options.flowName ?? rule.name,
    connector: options.connector,
    nodes,
  }
}
