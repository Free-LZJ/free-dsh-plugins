/**
 * 命中记录：它背着你做了什么。
 *
 * 这是整个内核里唯一一份**给人看的历史**，所以两件事以可读性为准：事件的主题与来源
 * 直接存下来（而不是只存一个 id 让人去别处查），失败原因存成人话（而不是错误码）。
 * 记录里的 `event` 由连接器决定形状——内核只要求它能被 `parseEvent` 认回来。
 *
 * 裁剪策略是「先按天数、再按条数」：只按条数裁会让「今天发生了 600 件事」把上周的
 * 记录挤掉；只按天数裁会让一次事故可以写下几万条。两者都设上限才收敛。
 *
 * @module @free-lzj/dsh-decision/runs
 */

import { randomUUID } from 'node:crypto'
import { readJson, serialWriter } from './store.ts'

/** 一条记录的状态。 */
export type RunStatus = 'done' | 'partial' | 'skipped' | 'suggested' | 'undone'

/** 记录里一个动作的结果。 */
export interface RunAction {
  readonly kind: string
  readonly mode: string
  readonly ok: boolean
  /** 给人看的一行说明，含失败原因。 */
  readonly detail: string
  /** `session` 动作建出的会话，供人点进去看。 */
  readonly sessionId?: string
}

/**
 * 记录里与来源无关的那一半。
 *
 * `event` 的形状留给连接器：内核不知道也不该知道一个事件长什么样，它只负责把它
 * 写下来、读回来、按天裁掉。连接器靠 `parseEvent` 说明「这条记录还能不能认」。
 */
export interface RunRecord<TEvent> {
  readonly id: string
  readonly at: string
  readonly ruleId: string
  readonly ruleName: string
  readonly label: string
  /** 被规则处理的那个事件，形状由连接器决定。 */
  readonly event: TEvent
  readonly actions: readonly RunAction[]
  readonly status: RunStatus
  /** 撤销窗口的截止时间；过了就不能撤了。 */
  readonly undoableUntil?: string
}

/** 一份命中记录。 */
export type Run<TEvent> = RunRecord<TEvent>

/** `runs.json` 的形状。 */
interface RunsFile<TEvent> {
  readonly version: 1
  readonly runs: readonly Run<TEvent>[]
}

/** 一份命中记录的仓。 */
export interface RunStore<TEvent> {
  /** 从磁盘读；坏文件回落成空历史。 */
  load(): Promise<void>
  /** 最新的在前。 */
  list(): readonly Run<TEvent>[]
  /** 按 id 取一条。 */
  get(id: string): Run<TEvent> | undefined
  /** 追加一条并落盘；返回它。 */
  append(run: Omit<Run<TEvent>, 'id'> & { readonly id?: string }): Promise<Run<TEvent>>
  /** 就地把一条记录改成另一个状态（撤销用）。 */
  patch(
    id: string,
    change: { readonly status: RunStatus; readonly actions?: readonly RunAction[] },
  ): Promise<Run<TEvent> | undefined>
  /** 按保留策略裁剪并落盘。 */
  trim(options: { readonly limit: number; readonly days: number }, now: Date): Promise<void>
}

/** 打开一份命中记录时要的形状说明。 */
export interface RunStoreOptions<TEvent> {
  /** 文件路径；测试指到临时目录。 */
  readonly path: string
  /**
   * 把磁盘上的一条记录收成 `TEvent`；认不出就返回 undefined（这条记录被丢掉）。
   *
   * 放在这里而不是写死在 `parseRun` 里，是因为**旧形状的兼容是连接器自己的事**：
   * 内核不 import 任何连接器，也不该知道它们以前把事件存成叫什么。
   * @param record - 磁盘上的原始对象。
   * @returns 事件；不着这条记录不可信。
   */
  readonly parseEvent: (record: Readonly<Record<string, unknown>>) => TEvent | undefined
}

/** 合法的状态值；磁盘上出现的其它值一律按 `done`（宁可显示成做过，也不要丢记录）。 */
const STATUSES = new Set<RunStatus>(['done', 'partial', 'skipped', 'suggested', 'undone'])

/**
 * 读一条记录；字段不全或事件认不出来就当它不可信。
 *
 * **按字段重建**而不是把磁盘对象整个展开：旧版本写下的键（例如 `message`）不会跟着
 * 混进下一次落盘，记录的形状只有这一个来源。
 */
function parseRun<TEvent>(
  value: unknown,
  parseEvent: RunStoreOptions<TEvent>['parseEvent'],
): Run<TEvent> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const run = value as Record<string, unknown>
  if (typeof run['id'] !== 'string' || typeof run['at'] !== 'string' || typeof run['ruleId'] !== 'string') return undefined
  if (!Array.isArray(run['actions'])) return undefined
  const event = parseEvent(run)
  if (event === undefined) return undefined
  const status = run['status']
  return {
    id: run['id'],
    at: run['at'],
    ruleId: run['ruleId'],
    ruleName: typeof run['ruleName'] === 'string' ? run['ruleName'] : run['ruleId'],
    label: typeof run['label'] === 'string' ? run['label'] : run['ruleId'],
    event,
    actions: run['actions'] as readonly RunAction[],
    status: typeof status === 'string' && STATUSES.has(status as RunStatus) ? status as RunStatus : 'done',
    ...(typeof run['undoableUntil'] === 'string' ? { undoableUntil: run['undoableUntil'] } : {}),
  }
}

/**
 * 打开命中记录的仓。
 * @param options - 路径与「怎么把一条记录认回来」。
 * @returns 仓。
 */
export function createRunStore<TEvent>(options: RunStoreOptions<TEvent>): RunStore<TEvent> {
  const write = serialWriter()
  let runs: Run<TEvent>[] = []

  /** 读整份文件。 */
  const parseFile = (value: unknown): RunsFile<TEvent> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const file = value as { version?: unknown; runs?: unknown }
    if (file.version !== 1 || !Array.isArray(file.runs)) return undefined
    const parsed = file.runs
      .map(entry => parseRun(entry, options.parseEvent))
      .filter((run): run is Run<TEvent> => run !== undefined)
    return { version: 1, runs: parsed }
  }

  /** 最新的在前，写盘一次。 */
  async function persist(): Promise<void> {
    await write(options.path, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`)
  }

  return {
    async load() {
      const file = await readJson(options.path, parseFile, { version: 1, runs: [] })
      // 文件里本来就是「最新的在前」（落盘写的就是内存里这个顺序），不要再翻一次：
      // 翻两次等于重启后把历史倒过来读，而这件事以前真的发生过（老实现 `load` 里
      // 多了一次 `reverse`，此前没有测试盯着）。
      runs = [...file.runs]
    },
    list: () => [...runs],
    get: id => runs.find(run => run.id === id),
    async append(run) {
      const complete: Run<TEvent> = { ...run, id: run.id ?? `run-${randomUUID()}` }
      runs = [complete, ...runs]
      await persist()
      return complete
    },
    async patch(id, change) {
      const index = runs.findIndex(run => run.id === id)
      const current = runs[index]
      if (current === undefined) return undefined
      const updated: Run<TEvent> = {
        ...current,
        status: change.status,
        ...(change.actions === undefined ? {} : { actions: change.actions }),
      }
      runs = [...runs.slice(0, index), updated, ...runs.slice(index + 1)]
      await persist()
      return updated
    },
    async trim({ limit, days }, now) {
      const floor = now.getTime() - days * 24 * 60 * 60 * 1000
      const kept = runs
        .filter(run => Date.parse(run.at) >= floor)
        .slice(0, Math.max(limit, 0))
      if (kept.length === runs.length) return
      runs = kept
      await persist()
    },
  }
}
