/**
 * 分诊编排：一封邮件走完整条链路。
 *
 * 这一层只做「顺序」与「取数」，不认识任何具体条件或动作——它按注册表把活派出去。
 * 三件事的顺序是刻意的，而且换不动：
 *
 * 1. **先按 priority 匹配规则**（纯函数、便宜），命中之后才
 * 2. **读正文**（这是整条链路里唯一昂贵的 IMAP 往返，而且还可能要）
 * 3. **分类**（唯一可能花钱调模型的一步），最后才执行动作。
 *
 * 反过来先读正文再匹配，就会为每一封广告邮件付一次 FETCH。
 *
 * 两段式（先声明式规则、再模型判类）也是刻意的：真实邮件头里带着足够多确定性信号
 * （`list-id`、`list-unsubscribe`），它们免费且准确，排在前面的规则命中就不必问模型；
 * 模型只该处理残余——而残余正是「这封邮件属于哪一类」这种规则写不死的判断。
 *
 * **一封邮件只问一次模型**：所有启用规则里 `classifier` 条件的标签取并集，作为这一次
 * 判定的可选类型问一次，答案按「标签集 + 提示词」缓存。所以规则可以按类型各写一条、
 * 各配各的动作，却不必为每一类各付一次模型调用。
 *
 * @module @free-lzj/dsh-mail/triage/triage
 */

import { randomUUID } from 'node:crypto'
import type { ActionContext } from './actions/context.ts'
import type { ActionOutcome } from './actions/index.ts'
import type { ClassifyRequest, ClassifyResult, MatchContext } from './conditions.ts'
import type { ActionRegistry, ConditionRegistry, PendingStore, RunStore } from '@free-lzj/dsh-decision'
import { ruleMatches, runDueActions, undoRunById } from '@free-lzj/dsh-decision'
import type {
  ActionKind, ActionSpec, ConditionKind, ConditionSpec, Config, MailSummaryLike, PendingAction, Rule, Run,
  RunAction, RunStatus,
} from './types.ts'

/** 一封刚到的邮件。 */
export interface IncomingMail {
  readonly accountId: string
  readonly accountName: string
  readonly summary: MailSummaryLike
  /** 读正文；只有真的需要时才调（编排层保证最多一次）。 */
  readonly readBody: () => Promise<string>
}

/** 分诊要用到的全部东西，注入进来所以不需要宿主也能测。 */
export interface TriagePorts {
  readonly rules: () => readonly Rule[]
  readonly config: () => Config
  readonly conditions: ConditionRegistry<ConditionSpec, MatchContext, ConditionKind>
  readonly actions: ActionRegistry<ActionSpec, ActionContext, ActionOutcome, ActionKind>
  readonly runs: RunStore<Run['event']>
  readonly pending: PendingStore<PendingAction>
  /** 造一个动作上下文（含 mail / sessions / console 等端口与 `vars`）。 */
  readonly context: (input: {
    readonly mail: IncomingMail
    readonly body: string
    readonly rule: Rule
  }) => ActionContext
  /**
   * 造一个「重放」用的动作上下文。
   *
   * 与 {@link TriagePorts.context} 分开，因为延迟执行时手上没有正文，也没有当时那条
   * 规则（用户可能已经改了规则文件）。重放只需要邮件摘要与账号——动作配置本身存在
   * 队列里。
   */
  readonly replayContext: (input: {
    readonly summary: MailSummaryLike
    readonly accountId: string
    readonly accountName: string
    readonly ruleId: string
  }) => ActionContext
  /** 分类通道；没装时 `classifier` 条件判为未命中。 */
  readonly classify?: (request: ClassifyRequest) => Promise<ClassifyResult>
  readonly log: (message: string) => void
  readonly now?: () => Date
}

/** 一次匹配的中间状态：正文与分类结果都只取一次。 */
export interface MatchState {
  body?: string
  /**
   * 这次判定可以回答的标签集：所有启用规则里 `classifier` 条件的并集。
   *
   * 它必须包含**全部**规则关心的类型，否则模型只能从某一类里挑一个——回执类邮件会被
   * 迫选成「推广」。规则在一次分诊里不变，所以只算一次。
   */
  readonly labels: readonly string[]
  readonly classifications: Map<string, ClassifyResult | undefined>
}

/**
 * 所有启用规则里 `classifier` 条件的标签并集。
 * @param rules - 当前生效的规则。
 * @returns 去重后的标签，按首次出现的顺序；一条 `classifier` 都没写时是空数组。
 */
export function labelUniverse(rules: readonly Rule[]): readonly string[] {
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    for (const spec of rule.when) {
      if (spec.kind !== 'classifier') continue
      for (const label of spec.labels ?? []) seen.add(label)
    }
  }
  return [...seen]
}

/**
 * 一封邮件的处理结果；`run` 一定会被写下来（包括「什么都没做」）。
 * @param mail - 到达的邮件。
 * @param ports - 注入的依赖。
 * @returns 写下的那条记录。
 */
export async function triage(mail: IncomingMail, ports: TriagePorts): Promise<Run> {
  const config = ports.config()
  const at = (ports.now?.() ?? new Date()).toISOString()

  if (!config.enabled) {
    return await record(ports, mail, {
      at,
      ruleId: '(disabled)',
      ruleName: '分诊已关闭',
      label: 'skipped',
      actions: [],
      status: 'skipped',
    })
  }

  const state: MatchState = { labels: labelUniverse(ports.rules()), classifications: new Map() }
  for (const rule of ports.rules()) {
    if (!rule.enabled) continue
    if (!(await matches(rule, mail, ports, state))) continue
    return await apply(rule, mail, ports, state, at)
  }

  // 没有任何规则命中：**什么都不做**，但留一条记录，好让「为什么这封邮件没被处理」
  // 有答案。这也是验收信号之一。
  return await record(ports, mail, {
    at,
    ruleId: '(none)',
    ruleName: '没有规则命中',
    label: 'unmatched',
    actions: [],
    status: 'skipped',
  })
}

/**
 * 一条规则的条件是否全部成立（组间 AND）。
 *
 * 条件实现缺失时判为**不命中**并记一条日志：一个用了本部署没装的条件（比如没装
 * 分类通道时的 `classifier`）不该让整条规则报错，但也不能假装它成立了。
 *
 * 导出是给「试跑」用的：试跑要回答的是「这封邮件会命中哪条」，而它现在也可能命中
 * 一条模型规则——用同一套匹配与同一份分类缓存，答案才和真正到达时一致。
 * @param rule - 被检查的规则。
 * @param mail - 到达（或正在试跑）的邮件。
 * @param ports - 注入的依赖。
 * @param state - 这次匹配的中间状态（正文与分类结果）。
 * @returns 全部条件成立时为 true。
 */
export async function matches(rule: Rule, mail: IncomingMail, ports: TriagePorts, state: MatchState): Promise<boolean> {
  // 匹配的骨架在内核（懒取正文、短路、未知条件算不命中并记一行），这里只提供邮件这一侧的
  // 上下文：那三件事对所有连接器都一样，而 `summary` / `classify` 只有这里知道。
  return await ruleMatches(
    { name: rule.name, when: rule.when },
    {
      conditions: ports.conditions,
      context: inner => ({
        summary: mail.summary,
        accountName: mail.accountName,
        ...(inner.body === undefined ? {} : { body: inner.body }),
        ...(ports.classify === undefined ? {} : { classify: classifierFor(ports, state) }),
      }),
      // 正文写回调用方那份 state：「先匹配再执行」的后续步骤要复用同一次读取。
      readBody: async () => {
        const body = await mail.readBody()
        state.body = body
        return body
      },
      log: ports.log,
    },
  )
}

/**
 * 给 `classifier` 条件用的通道：一次判定只问一次模型，答案按「标签集 + 提示词」共享。
 *
 * 缓存键不再是规则 id：同一封邮件在按类型分诊时会被好几条规则各问一次「是不是我这一类」，
 * 但那几次的答案必然一样——问一次全类型、各规则从答案里认自己的类型，才是「一封邮件一次
 * 模型调用」。提示词进键是因为它真的会改变判定（`prompt` 是给模型看的额外说明）。
 */
function classifierFor(
  ports: TriagePorts,
  state: MatchState,
): (request: ClassifyRequest) => Promise<ClassifyResult> {
  return async (request) => {
    const key = `${state.labels.join('\u0000')}\u0001${request.prompt ?? ''}`
    const cached = state.classifications.get(key)
    if (cached !== undefined) return cached
    const ask = ports.classify
    /* v8 ignore next -- 调用方只在 classify 存在时才接线 */
    if (ask === undefined) return { label: 'uncertain', confidence: 0 }
    // 模型看到的是全集：它只回答「这封邮件是哪一类」，不替任何一条规则做决定。
    // 反过来，答案落在哪条规则的 `labels` 里，那条规则就命中——命中语义没变。
    const answer = await ask(
      state.labels.length === 0 ? request : { ...request, labels: state.labels },
    )
    state.classifications.set(key, answer)
    return answer
  }
}

/** 执行一条规则的动作列表，并把结果汇总成一条记录。 */
async function apply(
  rule: Rule,
  mail: IncomingMail,
  ports: TriagePorts,
  state: MatchState,
  at: string,
): Promise<Run> {
  const config = ports.config()
  const body = state.body ?? (await mail.readBody())
  const context = ports.context({ mail, body, rule })
  const results: RunAction[] = []
  const undos: (() => Promise<void>)[] = []
  let undoableUntil: string | undefined
  // 记录 id 先定下来：排队项要带着它落盘，而写记录要等动作都跑完（记录里含结果）。
  // 先占位再回填会让「撤销」有机会撤到另一条记录上。
  const runId = `run-${randomUUID()}`

  for (const [index, spec] of rule.then.entries()) {
    const mode = spec.mode ?? 'auto'
    if (mode === 'off') {
      results.push({ kind: spec.kind, mode, ok: true, detail: '按配置关闭' })
      continue
    }
    if (config.dryRun) {
      results.push({ kind: spec.kind, mode, ok: true, detail: '试运行：只记录，未执行' })
      continue
    }
    if (mode === 'suggest') {
      // 「建议」不执行，只推一条**能点的**条目——这是不可撤销动作的默认三态。
      const itemId = await advise(spec, context, ports)
      if (itemId !== undefined) {
        // 把「用户点了同意之后该做什么」持久化下来。到期时间给一个远期值：建议不按
        // 时间失效（`takeDue` 也只看 `undo`），这里只是让存储层有个必填字段。
        await ports.pending.add({
          runId,
          ruleId: rule.id,
          actionIndex: index,
          action: spec,
          message: messageRef(mail),
          summary: mail.summary,
          kind: 'suggest',
          itemId,
          dueAt: new Date(Date.parse(at) + 365 * 24 * 3600 * 1000).toISOString(),
        })
      }
      results.push({ kind: spec.kind, mode, ok: true, detail: `已建议执行 ${spec.kind}` })
      continue
    }
    const action = ports.actions.get(spec.kind)
    if (action === undefined) {
      results.push({ kind: spec.kind, mode, ok: false, detail: `本部署没有实现动作 ${spec.kind}` })
      continue
    }
    const delay = spec.delaySeconds ?? (action.sideEffect ? config.undoWindowSeconds : 0)
    if (delay > 0) {
      // 有副作用且设了撤销窗口：排队，等窗口过去再真做。这样「撤销」是「没发生过」，
      // 而不是「尽量回滚」（IMAP 的移动一旦发生，别的设备就看见了）。
      const dueAt = new Date(Date.parse(at) + delay * 1000).toISOString()
      await ports.pending.add({
        runId,
        ruleId: rule.id,
        actionIndex: index,
        action: spec,
        message: messageRef(mail),
        summary: mail.summary,
        accountName: mail.accountName,
        kind: 'undo',
        dueAt,
      })
      undoableUntil = dueAt
      results.push({ kind: spec.kind, mode, ok: true, detail: `已排队，${String(delay)} 秒后执行（此前可撤销）` })
      continue
    }
    const outcome = await action.run(spec, context)
    if (outcome.undo !== undefined) undos.push(outcome.undo)
    results.push({
      kind: spec.kind,
      mode,
      ok: outcome.ok,
      detail: outcome.detail,
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
    })
  }

  const status = statusOf(results, { dryRun: config.dryRun })
  const run = await record(ports, mail, {
    id: runId,
    at,
    ruleId: rule.id,
    ruleName: rule.name,
    label: rule.label ?? rule.name,
    actions: results,
    status,
    ...(undoableUntil === undefined ? {} : { undoableUntil }),
  })
  // 撤销闭包活在内存里：撤销窗口是分钟级，跨重启的撤销由 pending 队列承担。
  undosByRun.set(run.id, undos)
  // 记一条自动化日志——**不**举条目：做过的事不需要人决定，进队列只会打扰。
  const did = results.filter(result =>
    result.ok && !result.detail.startsWith('试运行') && !result.detail.startsWith('已建议'))
  if (did.length > 0) {
    context.console?.log?.({
      source: 'mail',
      title: `按「${rule.name}」处理了：${mail.summary.subject}`,
      detail: did.map(result => result.detail).join('；'),
      ok: !results.some(result => !result.ok),
    })
  }
  return run
}

/** 内存里的撤销闭包，按记录 id 索引。 */
const undosByRun = new Map<string, readonly (() => Promise<void>)[]>()

/**
 * 「建议」模式：推一条**能点的**条目。
 *
 * 优先用工作台的条目接口（`raise`）：那样用户可以直接在通知里点「执行」，点击被路由回
 * 这里真正把动作做掉。工作台太旧、只有 `notify` 时退化成一条纯通知——建议仍然看得到，
 * 只是得手动去做。
 * @param spec - 被建议的动作。
 * @param context - 动作上下文。
 * @param ports - 注入的依赖。
 * @returns 条目 id（用于之后反查这条建议）；没有条目能力时 undefined。
 */
async function advise(spec: { readonly kind: string; readonly title?: string }, context: ActionContext, ports: TriagePorts): Promise<string | undefined> {
  const workbench = context.console
  const title = `建议处理：${context.task.summary.subject}`
  const body = `规则「${context.task.rule.name}」建议执行 ${spec.kind}`
  if (workbench === undefined) {
    ports.log(`[mail 分诊] 未安装工作台，建议未送出：${title}`)
    return undefined
  }
  if (workbench.raise !== undefined) {
    try {
      const item = await workbench.raise({
        title,
        body,
        tone: 'info',
        source: 'mail',
        kind: 'mail',
        actions: [
          { id: 'apply', label: `执行（${spec.kind}）`, style: 'primary' },
          { id: 'skip', label: '不用' },
        ],
      })
      return item?.id
    } catch (error: unknown) {
      ports.log(`[mail 分诊] 推送建议失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  try {
    await workbench.notify?.({ title, body, tone: 'info', source: 'mail' })
  } catch (error: unknown) {
    ports.log(`[mail 分诊] 推送建议失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

/** 汇总一条记录的状态。 */
function statusOf(results: readonly RunAction[], options: { readonly dryRun: boolean }): RunStatus {
  if (options.dryRun) return 'skipped'
  if (results.length === 0) return 'skipped'
  if (results.some(result => !result.ok)) return 'partial'
  // 一个都没真执行、但每条都写了「试运行」——那不算做过任何事。
  if (results.every(result => result.detail.startsWith('试运行'))) return 'skipped'
  if (results.every(result => result.detail.startsWith('已建议') || result.detail.startsWith('建议'))) return 'suggested'
  return 'done'
}

/** 记录里的邮件身份。 */
function messageRef(mail: IncomingMail): Run['event'] {
  return {
    accountId: mail.accountId,
    folder: mail.summary.folder,
    uid: mail.summary.uid,
    uidValidity: mail.summary.uidValidity,
    from: mail.summary.from.name === undefined
      ? mail.summary.from.address
      : `${mail.summary.from.name} <${mail.summary.from.address}>`,
    subject: mail.summary.subject,
  }
}

/** 写下一条记录。 */
async function record(
  ports: TriagePorts,
  mail: IncomingMail,
  input: {
    readonly id?: string
    readonly at: string
    readonly ruleId: string
    readonly ruleName: string
    readonly label: string
    readonly actions: readonly RunAction[]
    readonly status: RunStatus
    readonly undoableUntil?: string
  },
): Promise<Run> {
  return await ports.runs.append({
    ...(input.id === undefined ? {} : { id: input.id }),
    at: input.at,
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    label: input.label,
    event: messageRef(mail),
    actions: input.actions,
    status: input.status,
    ...(input.undoableUntil === undefined ? {} : { undoableUntil: input.undoableUntil }),
  })
}

/**
 * 撤销一条记录。
 *
 * 只能撤**还在窗口内**的：窗口过了动作已经真的发生，此时「撤销」是回滚而不是取消，
 * 语义不同、风险也不同。窗口内的排队项直接取消，这才是真正干净的撤销。
 * @param runId - 记录 id。
 * @param ports - 注入的依赖。
 * @returns 结果与一句说明。
 */
export async function undoRun(runId: string, ports: TriagePorts): Promise<{ ok: boolean; message: string }> {
  // 取消（还没发生的）与回滚（已经发生的）的区别、逆序回滚、失败只记不抛——都在内核里。
  // 这里只把「这条记录排队的动作」翻译成「取消它们并数一数」，以及交出撤销闭包。
  return await undoRunById(runId, {
    runs: {
      get: id => ports.runs.get(id),
      // 内核只知道「状态是一个字符串」，这里转回这个包自己的状态集合。
      patch: async (id, change) => await ports.runs.patch(id, { status: change.status as RunStatus }),
    },
    pendingFor: async (id) => {
      const queued = ports.pending.list().filter(item => item.runId === id)
      for (const item of queued) await ports.pending.cancel(item.id)
      return queued.length
    },
    undosFor: id => undosByRun.get(id) ?? [],
    log: ports.log,
  })
}

/**
 * 执行到期的延迟动作。
 *
 * 这是「撤销窗口」的另一半：窗口内被撤销的项已经被 `undoRun` 从队列里删掉了，剩下
 * 到期的才在这里真的发生。
 *
 * 两条取舍：每个动作**单独执行、单独记结果**（一个失败不影响后面的，IMAP 动作本来
 * 就不是事务性的）；执行完把撤销闭包登记回去，所以**执行之后仍然可以撤销**——只是
 * 那时是回滚而不是取消。
 * @param ports - 注入的依赖。
 * @param now - 现在；测试可钉死。
 * @returns 执行了几条。
 */
export async function runDue(ports: TriagePorts, now: Date = ports.now?.() ?? new Date()): Promise<number> {
  // 骨架在内核（逐个执行、单独记结果、回填记录、登记撤销闭包），这里只提供邮件这一侧的
  // 上下文与撤销登记。
  return await runDueActions(
    {
      pending: ports.pending,
      runs: {
        get: runId => ports.runs.get(runId),
        // 内核只知道「状态 + 动作列表」；把动作列表交给这个包自己的 RunAction 存储。
        patch: async (runId, change) => await ports.runs.patch(runId, {
          status: change.status as RunStatus,
          actions: change.actions as readonly RunAction[],
        }),
      },
      actions: ports.actions,
      contextFor: item => ports.replayContext({
        summary: item.summary,
        accountId: item.message.accountId,
        // 账号名字要在排队时记下来：`message` 里只有 id，用它当名字会让延迟执行的通知
        // 显示成一串 id。旧记录没有这个字段时退回 id，而不是空字符串。
        accountName: item.accountName ?? item.message.accountId,
        ruleId: item.ruleId,
      }),
      recordUndo: (runId, undo) => {
        const existing = undosByRun.get(runId) ?? []
        undosByRun.set(runId, [...existing, undo])
      },
      log: ports.log,
    },
    now,
  )
}
