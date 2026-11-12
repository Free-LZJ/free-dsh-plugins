/**
 * 邮件分诊的装配：把「邮件连接器」交给工作台核心。
 *
 * 这一层认识 cordis，别的模块都不认识。它只做三件事：
 *
 * 1. 造一个 {@link TaskConnector}（触发器、条件、分类、四个动作、端口）。
 * 2. 把它注册到**工作台核心**（`ctx.console.tasks`）——规则文件、任务链、撤销窗口都
 *    归那一个实例，所以「规则只有一份状态」是结构上成立的，而不是约定。
 * 3. 没装工作台时自己建一个同类引擎（同一个数据目录），邮件因此仍能独立分诊。
 *
 * 与旧实现相比，这里**不再有编排**：匹配、首命中、动作顺序、撤销、到期执行全在
 * `@free-lzj/dsh-decision` 的 `TaskRunner` 里。邮件这一侧只回答「发生了什么」和
 * 「邮件该被怎么改」。
 *
 * @module @free-lzj/dsh-mail/triage/mount
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TaskEngine, type TaskConnector } from '@free-lzj/dsh-decision'
import { createMailConnector, mailKeyOf, type LlmLike, type MailOpsLike } from '../connector.ts'
import type { Config } from './types.ts'
import type { MailReceivedPayload } from '../types.ts'

/** 会话服务里旧版宿主用得到的那部分（只在没有工作台会话端口时兜底）。 */
export interface TriageDeps {
  /** 本插件的数据目录；它的上一级就是 `$DSH_HOME`。 */
  readonly home: string
  /** 发货默认规则文件的绝对路径，第一次启动时写到规则文件的位置。 */
  readonly defaultRules: string
  readonly config: Config
  /** 邮件能力：本插件自己的服务。 */
  readonly mail: MailOpsLike
  readonly log: (message: string) => void
  readonly warn: (message: string) => void
}

/** 邮件插件拿着的那两个动词与一份状态。 */
export interface TriageEngine {
  readonly config: Config
  /**
   * 这次装配用的任务引擎。
   *
   * 装了工作台时它就是工作台持有的那一个；没装时是本插件自建的同类引擎。**没有**
   * 第二个 HTTP 出口：规则页读 `/dsh-console/rules/*`，邮件这一侧只把事件喂进去。
   */
  decision(): TaskEngine
  /** 一封刚到达的邮件：变成一个事件交给核心。 */
  emit(payload: MailReceivedPayload): void
  /** 空实现，保留给旧调用点（注册在构造时就完成了）。 */
  start(): void
  /** 停掉自建引擎（装了工作台时什么都不用停）。 */
  stop(): void
}

/**
 * 装配。
 * @param ctx - Host 插件上下文。
 * @param deps - 数据目录、默认规则、配置与邮件能力。
 * @returns 分诊入口。
 */
export function createTriage(ctx: Context, deps: TriageDeps): TriageEngine {
  const log = (message: string): void => deps.log(message)
  const warn = (message: string): void => deps.warn(message)

  /** 发货默认规则的原文；读不到就交空串——引擎会把「默认规则坏了」显式报出来。 */
  const defaultRulesText = (): string => {
    try {
      return readFileSync(deps.defaultRules, 'utf8')
    } catch (error: unknown) {
      warn(`mail: 读不到内置默认规则：${describe(error)}`)
      return ''
    }
  }

  const connector: TaskConnector = createMailConnector({
    mail: deps.mail,
    config: () => deps.config,
    ...(ctx.get('llm') === undefined ? {} : { llm: () => ctx.get('llm') as LlmLike | undefined }),
    log,
    warn,
    defaultRules: defaultRulesText(),
  })

  /** 工作台核心（它先装就先给它）。 */
  const sharedCore = (): TaskEngine | undefined =>
    (ctx.get('console') as { readonly tasks?: TaskEngine } | undefined)?.tasks

  /** 规则状态的家：与工作台的 ulesHome() 同一个约定（刻意写在这里，本插件不依赖工作台）。 */
  const rulesDir = join(dirname(deps.home), 'dsh-console', 'rules')

  /** 没装工作台时自建的那一台。 */
  let own: TaskEngine | undefined

  /** 现在该用哪台引擎。 */
  const coreOf = (): TaskEngine => {
    const shared = sharedCore()
    if (shared !== undefined) return shared
    if (own === undefined) {
      own = new TaskEngine({ home: rulesDir, config: () => deps.config, log, warn })
      own.register(connector)
      void own.start()
      log('mail: 没有工作台核心，已自建一台同类引擎（数据目录相同）')
    }
    return own
  }

  // 工作台可能比本插件晚挂载：一出现就把连接器交过去，并停掉自建的那台。
  ctx.inject(['console'], (inner) => {
    inner.effect(() => {
      const shared = (inner.get('console') as { readonly tasks?: TaskEngine } | undefined)?.tasks
      if (shared === undefined) return () => undefined
      const unregister = shared.register(connector)
      if (own !== undefined) {
        own.stop()
        own = undefined
      }
      return () => { unregister() }
    }, 'mail: hand the connector to the workbench core')
  })

  return {
    config: deps.config,
    decision: () => coreOf(),
    emit(payload) {
      const summary = payload.summary
      void coreOf().emit({
        type: 'mail.received',
        source: 'mail',
        dedupeKey: mailKeyOf({ accountId: payload.accountId, folder: summary.folder, uid: summary.uid }),
        payload: {
          accountId: payload.accountId,
          accountName: payload.accountName,
          folder: summary.folder,
          uid: summary.uid,
          uidValidity: summary.uidValidity,
          from: summary.from,
          subject: summary.subject,
          date: summary.date,
          headers: summary.headers,
          snippet: summary.snippet,
          seen: summary.seen,
          flagged: summary.flagged,
          hasAttachments: summary.hasAttachments,
        },
      }).catch((error: unknown) => {
        warn(`mail: 分诊「${summary.subject}」失败：${describe(error)}`)
      })
    },
    start() {
      // 注册在构造时已经完成；这里只确保引擎起来了。
      void coreOf().start()
    },
    stop() {
      own?.stop()
      own = undefined
    },
  }
}

/** 描述任意抛出物。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
