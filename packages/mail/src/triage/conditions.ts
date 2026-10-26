/**
 * 条件注册表：一封邮件「算不算这一类」的全部判断都住在这里。
 *
 * 每种条件一个实现、一个文件，内核只认识 {@link Condition} 这个接口。新增一种
 * 条件（比如「按 SPF 结果」「按附件大小」）只加一个文件并在装配处注册，不改这里
 * 的任何一行——这是 `rules/design-patterns.md` 对「一个能力有多种实现」的硬要求。
 *
 * 匹配语义与 `packages/mail` 现有的过滤规则**故意保持一致**（小写子串、组内 OR、
 * 组间 AND）：同一封邮件在旧路径与新路径下的判定不该因为重构而改变。
 *
 * @module @free-lzj/dsh-mail/triage/conditions
 */

import type { ConditionKind, ConditionSpec, MailSummaryLike } from './types.ts'

/**
 * 一次匹配能看到的全部东西。
 *
 * `body` 与 `classify` 都是可选的，因为它们各自代表一次昂贵的取数：正文是 IMAP
 * 往返，分类是一次模型调用。编排层只在真的有条件需要时才填，条件实现必须自己
 * 处理「没给」的情况（`needsBody` / `async` 就是给编排层看的声明）。
 */
export interface MatchContext {
  readonly summary: MailSummaryLike
  readonly accountName: string
  /** 正文；只有 `needsBody` 的条件会拿到它。 */
  readonly body?: string
  /** 分类通道；只有 `classifier` 会调它。 */
  readonly classify?: (request: ClassifyRequest) => Promise<ClassifyResult>
}

/** 交给分类通道的东西。 */
export interface ClassifyRequest {
  readonly summary: MailSummaryLike
  readonly accountName: string
  readonly body: string
  readonly labels: readonly string[]
  /** 追加在发货提示词之后的自定义说明。 */
  readonly prompt?: string
}

/**
 * 分类通道的回答。
 *
 * **没有 `actions` 字段是刻意的**：模型只能回答「这属于哪一类」，动作由规则文件
 * 里写的 `then` 决定。市面调研的结论是没有通用防御提示词（IEEE EASE 15336 次
 * 实验），所以硬边界必须落在类型上——模型看不见动作，也就改不了动作。
 */
export interface ClassifyResult {
  readonly label: string
  /** 0–1；低于编排层阈值时会被当作未命中。 */
  readonly confidence: number
  readonly reason?: string
}

/**
 * 一个条件实现。
 *
 * `needsBody` 与 `async` 不是元数据装饰，而是编排层的取数依据：声明了才付代价。
 */
export interface Condition {
  readonly kind: ConditionKind
  /** 这个条件**总是**需要正文；编排层据此决定要不要 FETCH。 */
  readonly needsBody: boolean
  /**
   * 这个条件要不要正文取决于它的配置。
   *
   * 只有 `regex` 用得上：`field: body` 要读正文，`field: subject` 不读。声明在 spec 上
   * 而不是在实现上，是因为「读不读」是**每条规则**的决定，而不是每种条件的决定——
   * 如果一个正则条件永远要求正文，那些只看主题的规则就要为每封邮件多付一次 FETCH。
   * @param spec - 已收窄的条件配置。
   * @returns 这条配置需要正文时为 true。
   */
  needsBodyFor?(spec: ConditionSpec): boolean
  /** 这个条件会异步（只有 `classifier` 会）。 */
  readonly async?: boolean
  /**
   * 判断是否命中。
   * @param spec - 已经过 `normalizeCondition` 收窄的条件。
   * @param context - 这封邮件能提供的一切。
   * @returns 命中为 true。
   */
  test(spec: ConditionSpec, context: MatchContext): boolean | Promise<boolean>
}

/* ─────────────────────────────── 具体实现 ─────────────────────────────── */

/** 组内 OR：任一子串命中即算命中；空组视为未命中（写歪胜过匹配一切）。 */
function anyNeedle(haystack: string, needles: readonly string[] | undefined): boolean {
  if (needles === undefined) return false
  const hay = haystack.toLowerCase()
  return needles.some((needle) => hay.includes(needle.trim().toLowerCase()))
}

/** 把地址渲染成可匹配的一串，形如 `Name <addr>` 与裸地址都在里面。 */
function addressesOf(value: string | undefined): string {
  return value ?? ''
}

/**
 * `from`：对发件人的名字与地址做子串匹配。
 *
 * 名字也在匹配范围内，因为真实邮件里「GitHub」这种字样的价值与地址等价，而
 * 只匹配地址会让 `any: ['github']` 这种写法失效。
 */
export const fromCondition: Condition = {
  kind: 'from',
  needsBody: false,
  test: (spec, context) =>
    anyNeedle(`${context.summary.from.address} ${context.summary.from.name ?? ''}`, spec.any),
}

/**
 * `to`：对收件人与抄送做子串匹配。
 *
 * 读的是头部而不是摘要字段——摘要里没有收件人，而 `to`/`cc` 已经进了白名单头部。
 * 一封抄送给你的邮件与直接发给你的邮件常常要不同处理（通知 vs 待办）。
 */
export const toCondition: Condition = {
  kind: 'to',
  needsBody: false,
  test: (spec, context) =>
    anyNeedle(
      `${addressesOf(context.summary.headers['to'])} ${addressesOf(context.summary.headers['cc'])}`,
      spec.any,
    ),
}

/** `subject`：对主题做子串匹配。 */
export const subjectCondition: Condition = {
  kind: 'subject',
  needsBody: false,
  test: (spec, context) => anyNeedle(context.summary.subject, spec.any),
}

/** `body`：对正文做子串匹配；没拿到正文时判为未命中而不是报错。 */
export const bodyCondition: Condition = {
  kind: 'body',
  needsBody: true,
  test: (spec, context) => (context.body === undefined ? false : anyNeedle(context.body, spec.any)),
}

/**
 * `header`：按邮件头匹配。
 *
 * 这是整套设计里最有价值的一个条件：GitHub 的 `list-id` 带着 `Owner/Repo`，
 * `list-unsubscribe` 是群发的可靠标记，`x-qq-csender` 暴露真实信封发件人
 * （From 会被伪造）。只给 `name` 不给 `any` 表示「有没有这个头」。
 */
export const headerCondition: Condition = {
  kind: 'header',
  needsBody: false,
  test: (spec, context) => {
    if (spec.name === undefined) return false
    const value = context.summary.headers[spec.name.toLowerCase()]
    if (value === undefined) return false
    if (spec.any === undefined) return true
    return anyNeedle(value, spec.any)
  },
}

/**
 * `regex`：对指定字段做正则匹配。
 *
 * 正则的**编译放在加载期**（`src/rules.ts` 会预编译一遍），所以这里假定 pattern
 * 已经能编译。运行期仍用 try/catch 兜一层：一个还没被校验过的规则不该让整封邮件
 * 的处理崩掉。
 */
export const regexCondition: Condition = {
  kind: 'regex',
  needsBody: false,
  // `field: body` 才读正文；只看发件人 / 主题的正则不该触发一次 IMAP 往返。
  needsBodyFor: spec => spec.field === 'body',
  test: (spec, context) => {
    if (spec.pattern === undefined || spec.field === undefined) return false
    const value = fieldValue(spec.field, context)
    if (value === undefined) return false
    try {
      return new RegExp(spec.pattern, 'i').test(value)
    } catch {
      return false
    }
  },
}

/** 取正则要作用的字段；`body` 没拿到就是 undefined。 */
function fieldValue(field: 'from' | 'to' | 'subject' | 'body', context: MatchContext): string | undefined {
  switch (field) {
    case 'from':
      return `${context.summary.from.address} ${context.summary.from.name ?? ''}`
    case 'to':
      return `${addressesOf(context.summary.headers['to'])} ${addressesOf(context.summary.headers['cc'])}`
    case 'subject':
      return context.summary.subject
    case 'body':
      return context.body
  }
}

/**
 * `attachment`：按「有没有附件」与扩展名匹配。
 *
 * 扩展名这一半第一版**不实现**：摘要里只有 `hasAttachments`，扩展名要解析正文结构
 * 才拿得到，而为一个还没人用到的条件多付一次解析不划算。写了 `extensions` 的条件
 * 会退化成只看「有没有附件」——这比静默失效好，但仍要在 README 的已知限制里写明。
 */
export const attachmentCondition: Condition = {
  kind: 'attachment',
  needsBody: false,
  test: (spec, context) => {
    const wanted = spec.has ?? true
    return context.summary.hasAttachments === wanted
  },
}

/**
 * `classifier`：交给模型判断。
 *
 * 这是唯一一个**会改变「要不要相信邮件内容」边界**的条件，所以它的输出被限制成
 * 一个标签（见 `ClassifyResult` 的注释）。没装分类通道时判为未命中，而不是抛错：
 * 一个可选能力缺失应当让规则安静地不生效。
 */
export const classifierCondition: Condition = {
  kind: 'classifier',
  needsBody: true,
  async: true,
  test: async (spec, context) => {
    if (context.classify === undefined) return false
    const labels = spec.labels ?? []
    const body = context.body ?? context.summary.snippet
    const result = await context.classify({
      summary: context.summary,
      accountName: context.accountName,
      body,
      labels,
      ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
    })
    // 声明了标签集就要求答案落在集合里；没声明则任何非空标签都算命中。
    if (labels.length > 0 && !labels.includes(result.label)) return false
    return result.label !== '' && result.label !== 'uncertain'
  },
}

/**
 * 本部署发货的全部条件实现。
 *
 * 列在一个函数里而不是散在各处，是为了让「装了哪些条件」一眼可见——装配处只调
 * 这一个函数，新增实现只改这个数组（内核 `ConditionRegistry` 不动）。
 * @returns 全部内置条件，按注册顺序。
 */
export function builtinConditions(): readonly Condition[] {
  return [
    fromCondition,
    toCondition,
    subjectCondition,
    bodyCondition,
    headerCondition,
    regexCondition,
    attachmentCondition,
    classifierCondition,
  ]
}
