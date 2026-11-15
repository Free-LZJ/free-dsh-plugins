/**
 * 规则 → BPMN：把「按优先级首命中」翻译成一棵 if / else-if 链。
 *
 * 为什么是编译而不是新写一个执行器：控制流一旦是显式的（网关 + 连线），画图就不再
 * 需要从数据顺序反推，分支也不再藏在 `priority` 排序里。规则文件仍然是 YAML——
 * agent 直接改它——BPMN 只是它对执行器与渲染器的呈现。
 *
 * 翻译的形状（三条规则为例）：
 *
 * ```
 * start → gw(r0) ─[hit_r0]→ act(r0,0) → act(r0,1) → end(r0)
 *                └[else]→ gw(r1) ─[hit_r1]→ … → end(r1)
 *                          └[else]→ … → rest
 * ```
 *
 * **流程里没有判定节点**：命中的布尔值在跑流程之前就算好了（见 `execute.ts`）。这不是
 * 妥协，是 bpmn-engine 的真实约束——它会在入边被 take 的瞬间求值网关条件，而 take
 * 发生在源活动**开始**时，所以「异步判定节点 → 网关」会读到还没写好的变量。把判定
 * 挪到流程外，网关就只剩同步的条件求值，语义与原来「先分类、再首命中」一致。
 *
 * @module @free-lzj/dsh-decision/bpmn/compile
 */

import type { ActionSpecLike, ConditionSpecLike } from '../registry.ts'
import type { Rule } from '../types.ts'

/** 一个 serviceTask 在流程里的身份。执行器靠节点 id 反查它要做什么。 */
export type FlowStep = { readonly kind: 'action'; readonly ruleId: string; readonly index: number }

/** 编译产物：给人（渲染器）的 XML，与给执行器的计划表。 */
export interface CompiledFlow {
  readonly xml: string
  /** serviceTask 节点 id → 它要做什么。 */
  readonly steps: ReadonlyMap<string, FlowStep>
  /** 规则 id，按优先级顺序；下标就是命中变量名的序号。 */
  readonly order: readonly string[]
  /** `order` 里哪些下标命中后仍要继续问下一条（对应 `stopOnMatch: false`）。 */
  readonly continues: readonly number[]
  /** 规则 id → 它在链上显示的名字（`label`，缺省为 `name`）。 */
  readonly labels: ReadonlyMap<string, string>
  /** 编译时发现、但这一版表达不了的规则说明。 */
  readonly dropped: readonly string[]
}

/** 编译选项。 */
export interface CompileOptions {
  /** 流程 id；同一份规则文件里稳定即可。 */
  readonly processId?: string
  readonly name?: string
}

/** XML 文本转义：规则名、动作名进属性，必须挡住 `&<>"'`。 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 节点 id 只允许 `[A-Za-z0-9_]`，且必须唯一——用下标兜底，不靠规则 id。 */
function slot(index: number): string {
  return `r${String(index)}`
}

/**
 * 命中标志的变量名。流程外的判定写它，流程里的网关读它。
 * @param index - 规则在链上的序号。
 * @returns 变量名。
 */
export function hitVariable(index: number): string {
  return `hit_${slot(index)}`
}

/**
 * 把规则编译成 BPMN。
 *
 * 这一版刻意只表达「首命中 + 顺序动作」：`stopOnMatch: false`（命中后继续追加）不在
 * if / else-if 链的表达范围内，会被丢弃并说明原因——**丢弃而不是静默当成 true**，
 * 因为把「继续追加」悄悄变成「只跑第一条」会少做动作，而少做动作很难被发现。
 * @param rules - 已经按 priority 升序、只含启用规则的列表。
 * @param options - 流程 id 与名字。
 * @returns 编译产物。
 */
export function compileRules(
  rules: readonly Rule<ConditionSpecLike, ActionSpecLike>[],
  options: CompileOptions = {},
): CompiledFlow {
  const processId = options.processId ?? 'rules'
  const processName = options.name ?? '规则'
  const nodes: string[] = [`<startEvent id="start" name="事件到达" />`, `<endEvent id="rest" name="不处理" />`]
  const flows: string[] = []
  const steps = new Map<string, FlowStep>()
  const dropped: string[] = []
  const kept: { rule: Rule<ConditionSpecLike, ActionSpecLike>; index: number }[] = []

  for (const rule of rules) {
    if (rule.then.length === 0) {
      dropped.push(`规则「${rule.name}」没有任何动作，跳过`)
      continue
    }
    kept.push({ rule, index: kept.length })
  }

  /** `stopOnMatch: false` 的规则命中后不结束，继续问下一条，后续命中的 then 依次追加。 */
  const continues: number[] = []
  const labels = new Map<string, string>()

  kept.forEach(({ rule, index }, position) => {
    const id = slot(index)
    const gatewayId = `gw_${id}`
    const elseFlow = `else_${id}`
    const lastKept = position === kept.length - 1
    const nextTarget = lastKept ? 'rest' : `gw_${slot(index + 1)}`
    const carriesOn = rule.stopOnMatch === false
    if (carriesOn) continues.push(index)
    labels.set(rule.id, rule.label ?? rule.name)

    nodes.push(`<exclusiveGateway id="${gatewayId}" name="${esc(rule.label ?? rule.name)}" default="${elseFlow}" />`)
    // 命中后还要继续问的规则没有自己的收尾：它把 token 交给下一条网关。
    if (!carriesOn) nodes.push(`<endEvent id="end_${id}" name="已处理" />`)

    // 只有第一条规则需要从 start 进来；后续规则的入口是上一条的 else 边。
    if (position === 0) {
      flows.push(`<sequenceFlow id="in_${id}" sourceRef="start" targetRef="${gatewayId}" />`)
    }

    let previous = gatewayId
    rule.then.forEach((action, actionIndex) => {
      const actionId = `act_${id}_${String(actionIndex)}`
      steps.set(actionId, { kind: 'action', ruleId: rule.id, index: actionIndex })
      nodes.push(
        `<serviceTask id="${actionId}" name="${esc(action.kind)}" implementation="\${environment.services.step}" />`,
      )
      const condition = actionIndex === 0
        ? `<conditionExpression xsi:type="tFormalExpression">\${environment.variables.${hitVariable(index)}}</conditionExpression>`
        : ''
      flows.push(
        `<sequenceFlow id="f_${id}_${String(actionIndex)}" sourceRef="${previous}" targetRef="${actionId}">${condition}</sequenceFlow>`,
      )
      previous = actionId
    })

    flows.push(`<sequenceFlow id="fin_${id}" sourceRef="${previous}" targetRef="${carriesOn ? nextTarget : `end_${id}`}" />`)
    flows.push(`<sequenceFlow id="${elseFlow}" sourceRef="${gatewayId}" targetRef="${nextTarget}" />`)
  })

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             targetNamespace="http://free-lzj.dev/dsh/decision">
  <process id="${esc(processId)}" name="${esc(processName)}" isExecutable="true">
    ${nodes.join('\n    ')}
    ${flows.join('\n    ')}
  </process>
</definitions>
`

  return {
    xml,
    steps,
    order: kept.map(({ rule }) => rule.id),
    continues,
    labels,
    dropped,
  }
}
