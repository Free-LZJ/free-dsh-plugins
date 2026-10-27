/**
 * 注册表：内核持有的集合，按 kind 注册与取出。
 *
 * 内核里**不出现任何实现的名字**——这是 `rules/design-patterns.md` 的可机械判断
 * 检查项之一（「内核文件里出现任一实现的名字 → 违反」）。新增一种条件或动作只
 * 新增一个文件，并在装配处把它注册进来；这两个类一行都不用改。
 *
 * 三个类型参数不是装饰：条件和动作的**配置**与**运行时上下文**都是连接器的知识
 * （邮件的条件要读发件人，Jira 的要读工单字段），内核只认识「有个 kind、能被调」。
 * 连接器用一行别名把它们填实（`type Condition = Condition<MailSpec, MailContext>`），
 * 于是实现文件一行都不用改。
 *
 * @module @free-lzj/dsh-decision/registry
 */

/** 条件配置的最低要求：能被按 kind 分发。 */
export interface ConditionSpecLike {
  readonly kind: string
}

/** 一种条件的实现。 */
export interface Condition<TSpec extends ConditionSpecLike, TContext, TKind extends string = string> {
  readonly kind: TKind
  /** 这个条件**总是**需要正文；编排层据此决定要不要去取。 */
  readonly needsBody: boolean
  /**
   * 这个条件要不要正文取决于它的配置。
   *
   * 声明在配置上而不是实现上，是因为「读不读」是**每条规则**的决定：只看主题的
   * 规则不该为每封邮件多付一次读取。
   * @param spec - 已收窄的条件配置。
   * @returns 这条配置需要正文时为 true。
   */
  needsBodyFor?(spec: TSpec): boolean
  /** 这个条件会异步（例如问一次模型）。 */
  readonly async?: boolean
  /**
   * 判断是否命中。
   * @param spec - 已收窄的条件配置。
   * @param context - 这个事件能提供的一切。
   * @returns 命中为 true。
   */
  test(spec: TSpec, context: TContext): boolean | Promise<boolean>
}

/** 动作配置的最低要求：能被按 kind 分发。 */
export interface ActionSpecLike {
  readonly kind: string
}

/** 一个动作的实现。 */
export interface Action<TSpec extends ActionSpecLike, TContext, TOutcome, TKind extends string = string> {
  readonly kind: TKind
  /** 这个动作改了外部世界没有；编排层据此决定要不要进撤销窗口。 */
  readonly sideEffect: boolean
  /**
   * 执行。
   * @param spec - 已收窄的动作配置。
   * @param context - 这个事件与可用的宿主能力。
   * @returns 结果；**不要抛**，能力缺失与宿主拒绝都折成失败结果加一句说明。
   */
  run(spec: TSpec, context: TContext): Promise<TOutcome>
}

/** 条件注册表：按 kind 取实现。 */
export class ConditionRegistry<TSpec extends ConditionSpecLike, TContext, TKind extends string = string> {
  private readonly byKind = new Map<TKind, Condition<TSpec, TContext, TKind>>()

  /**
   * 注册一个条件实现。
   * @param condition - 实现；同 kind 重复注册会覆盖（热重载时有用）。
   */
  register(condition: Condition<TSpec, TContext, TKind>): void {
    this.byKind.set(condition.kind, condition)
  }

  /**
   * 取一个条件实现。
   * @param kind - 条件种类。
   * @returns 实现，或 undefined（这个部署没装这种条件）。
   */
  get(kind: TKind): Condition<TSpec, TContext, TKind> | undefined {
    return this.byKind.get(kind)
  }

  /** 已注册的 kind，用于「部署缺哪种条件」这类提示。 */
  kinds(): readonly TKind[] {
    return [...this.byKind.keys()]
  }
}

/** 动作注册表：按 kind 取实现。 */
export class ActionRegistry<TSpec extends ActionSpecLike, TContext, TOutcome, TKind extends string = string> {
  private readonly byKind = new Map<TKind, Action<TSpec, TContext, TOutcome, TKind>>()

  /**
   * 注册一个动作实现。
   * @param action - 实现；同 kind 重复注册会覆盖。
   */
  register(action: Action<TSpec, TContext, TOutcome, TKind>): void {
    this.byKind.set(action.kind, action)
  }

  /**
   * 取一个动作实现。
   * @param kind - 动作种类。
   * @returns 实现，或 undefined（这个部署没装这种动作）。
   */
  get(kind: TKind): Action<TSpec, TContext, TOutcome, TKind> | undefined {
    return this.byKind.get(kind)
  }

  /** 已注册的 kind。 */
  kinds(): readonly TKind[] {
    return [...this.byKind.keys()]
  }
}

/**
 * 把一组实现注册进注册表。
 *
 * 收成函数是因为装配处要注册两批（内置 + 将来第三方提供的），写成一行比循环清楚。
 * @param registry - 目标注册表。
 * @param items - 要注册的实现。
 */
export function registerAll<T extends { readonly kind: string }>(
  registry: { register(item: T): void },
  items: readonly T[],
): void {
  for (const item of items) registry.register(item)
}
