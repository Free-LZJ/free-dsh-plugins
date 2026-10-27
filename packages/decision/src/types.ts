/**
 * 内核里与来源无关的形状：一条规则、一次规则文件的错误、动作的三态。
 *
 * 规则本身是**结构**（名字、优先级、条件列表、动作列表），条件的配置与动作的配置
 * 是连接器的词表——所以这两个位置是泛型参数，内核不写死任何一种。
 *
 * @module @free-lzj/dsh-decision/types
 */

/**
 * 一个动作的三态：直接做、只建议、关掉。
 *
 * 默认值由连接器按「能不能撤销」定（见各连接器的配置层），内核只负责把它传下去
 * 并原样存回规则文件。
 */
export type ActionMode = 'auto' | 'suggest' | 'off'

/**
 * 一条规则。
 *
 * 条件是**组间 AND、组内 OR**：`when` 数组里每个元素都要成立，元素内部的组合由
 * 条件实现自己解释。顺序即优先级：`priority` 小的先匹配，首条命中生效。
 */
export interface Rule<TCondition, TAction> {
  /** 稳定标识，用于命中记录与页面定位；缺省由 name 派生。 */
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** 升序匹配，首条命中生效。缺省按数组下标 × 10。 */
  readonly priority: number
  /** 空数组 = 匹配一切（兜底规则）。 */
  readonly when: readonly TCondition[]
  /** 命中后打的标签；缺省 = 规则名。 */
  readonly label?: string
  readonly then: readonly TAction[]
  /** 命中后是否停止后续匹配。默认 true。 */
  readonly stopOnMatch?: boolean
}

/** 规则文件读出来但用不了时，给人看的那句话。 */
export interface RuleFileError {
  readonly message: string
  /** YAML 语法错误的位置（1 基，页面直接用）。 */
  readonly line?: number
}
