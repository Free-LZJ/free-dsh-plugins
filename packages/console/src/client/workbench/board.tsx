/**
 * The board: one task, one card, the whole chain underneath it.
 *
 * **What a card is.** Not an event and not a rule hit — a *task*. A task is what
 * one connector event became: one mail, one Jira ticket, one webhook. The engine
 * may act on the same task more than once (a retry, a follow-up, a second
 * session), and every one of those is a separate hit record in `runs.json`; they
 * all fold into the same card, because the user asked "what happened to this
 * thing", not "what fired at 10:31".
 *
 * **Where the chain comes from.** `RunRecord` already carries it: `ruleId` +
 * `ruleName` (which rule fired), `label` (what it was classified as), and
 * `actions[]` in execution order — each with `ok`, a human-readable `detail` and,
 * for a session, the `sessionId` to jump to. Nothing is inferred from titles any
 * more: the old `chain.ts` guessed by string similarity, and a guess is exactly
 * what the user was looking at when they said the board was wrong.
 *
 * **Three zones.** `todo` (waiting on a human: a failed action, a suggestion, or
 * a task inside its archive window), `running` (a session it opened is alive
 * right now), `archived` (done and out of the way). The archive rhythm is a
 * preference, not a data lifetime: the record stays in `runs.json` either way.
 *
 * @module @free-dsh-plugins/dsh-console/client/workbench/board
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, DisclosureRow, IconChevronDownOutlineRegular, Modal, Pill, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ArchiveRhythm, ConsoleNoticeRecord, Task, TaskNodeRecord, WorkbenchColumn, WorkbenchState,
} from '../../protocol.ts'
import type { Translate } from '../locales.ts'
import { CLS } from '../styles.ts'

/**
 * 旧看板的面：卡片、会话、连接器。
 *
 * 看板自己已经不渲染卡片了——链路来自引擎的命中记录，那是它亲手写下的证据，
 * 比按标题猜出来的分组可信。但连接器页与聚焦页仍在读这份快照：它们问的是
 * 「哪些连接器可用」「这台机器上跑着什么」，与链路无关，也就不必换数据源。
 */
export interface WorkbenchFace {
  /** Selector hook over the board state. */
  readonly useBoard: SnapshotSelectorHook<WorkbenchState | undefined>
  /** Selector hook over the workbench items. */
  readonly useNotices: SnapshotSelectorHook<readonly ConsoleNoticeRecord[]>
  readonly dispatch: (cardId: string, executor?: string) => Promise<boolean>
  readonly move: (cardId: string, column: WorkbenchColumn) => Promise<boolean>
  readonly interrupt: (sessionId: string, text: string) => Promise<boolean>
  readonly pause: (sessionId: string) => Promise<boolean>
  readonly resume: (sessionId: string) => Promise<boolean>
  readonly end: (sessionId: string) => Promise<boolean>
  readonly confirm: (cardId: string) => Promise<boolean>
  readonly detach: (cardId: string) => Promise<boolean>
  /**
   * 打开或关掉一个连接器的规则参与。
   *
   * 可选：一个没有任务引擎的部署（或更旧的宿主）没有这个动作，连接器页据此把开关
   * 画成锁住的，而不是给一个点了没反应的按钮。
   */
  readonly setConnector?: (id: string, enabled: boolean) => Promise<{ readonly ok: boolean; readonly message?: string }>
}

/* ─────────────────────────────── 数据类型 ─────────────────────────────── */

/** Which zone a task sits in. */
export type TaskZone = 'todo' | 'running' | 'archived'

/** One step of a chain, already worded. */
export interface ChainStep {
  /** Stable key inside the task. */
  readonly key: string
  /** `rule`, or the action's own kind (`session` / `notify` / `markRead` …). */
  readonly kind: string
  /** Short name of the step, localized by the caller. */
  readonly title: string
  /** The engine's own one-line account of what it did (or why it failed). */
  readonly detail: string
  readonly ok: boolean
  readonly at: number
  /** Present on a `session` step: the conversation this task opened. */
  readonly sessionId?: string
  /** 失败的性质；页面据此给出「去改规则」或「再试一次」。 */
  readonly failure?: RunFailure
}

/** The three kinds of failure, mirrored from the decision core. */
export type RunFailure = 'config' | 'transient' | 'fatal'

/**
 * 人还能对一次失败做什么。
 *
 * 由失败的性质决定，不由页面猜：配置错重试一万次也一样，目标没了只能放弃，
 * 只有「这次碰巧没成」才值得再试。
 */
export type Remedy = 'fix-config' | 'retry' | 'none'

/** One task: an event a connector emitted, and the chain it ran through. */
export interface TaskChain {
  /** Aggregation key; stable across repaints. */
  readonly key: string
  /** The tasks behind this card, oldest first (a later event may join the same chain). */
  readonly tasks: readonly Task[]
  /** The whole chain, oldest first. */
  readonly steps: readonly ChainStep[]
  readonly zone: TaskZone
  /** Headline: what the event was about. */
  readonly title: string
  /** Which connector it came from (`mail` today). */
  readonly source: string
  /** The classification this task last landed on. */
  readonly label: string
  /** Epoch ms of the newest activity. */
  readonly updatedAt: number
  /** True when any run in the task ended with a failed action. */
  readonly failed: boolean
  /** 第一个失败的步骤是什么性质；没有失败时 undefined。 */
  readonly failure?: RunFailure
  /** 人还能做什么：改配置、重试、还是只能承认它。 */
  readonly remedy: Remedy
  /** 人已经说过「这条我看到了」。 */
  readonly acknowledged: boolean
}

/* ─────────────────────────────── 聚合 ─────────────────────────────── */

/** 一格节点的名字：核心只给 kind，文案在这里。 */
function nodeTitle(node: TaskNodeRecord, t: Translate): string {
  if (node.kind === 'trigger') return t('linkKindTrigger')
  if (node.kind === 'classify') return t('linkKindClassify')
  if (node.kind === 'rule') return t('linkKindRule')
  if (node.kind === 'session') return t('linkKindSession')
  return kindLabel(node.kind, t)
}

/** 一条链的标题：触发它的那件事的名字（触发器给的，不再从事件里猜）。 */
function titleOf(task: Task, t: Translate): string {
  const title = task.title.trim()
  return title === '' ? t('taskNoSource') : title
}

/** 任务来自哪个连接器。 */
function sourceOf(task: Task): string {
  return task.connector
}

/**
 * The localized name of one action kind.
 *
 * The engine names kinds; the page words them. An unknown kind (a connector from
 * a newer build) is shown as its own id rather than dropped — a step that
 * happened is better shown plainly than hidden.
 * @param kind - the action kind.
 * @param t - the translate seat.
 * @returns the label.
 */
export function kindLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'session': return t('linkKindSession')
    case 'notify': return t('linkKindNotify')
    case 'markRead': return t('linkKindMarkRead')
    case 'markUnread': return t('linkKindMarkRead')
    case 'move': return t('linkKindMove')
    case 'flag': case 'unflag': return t('linkKindFlag')
    case 'archive': return t('linkKindArchive')
    case 'followup': return t('linkKindFollowup')
    case 'due': return t('linkKindDue')
    case 'script': return t('linkKindScript')
    case 'http': return t('linkKindHttp')
    case 'mcp': return t('linkKindMcp')
    default: return kind
  }
}

/**
 * Turn one task into the steps its card shows.
 *
 * 链就是任务自己的节点——不再从「命中记录」里拼：触发器、分类、规则、动作、会话
 * 本来就按发生顺序排在 `task.nodes` 里，页面只需要给每一格一个名字。
 * @param task - one task.
 * @param t - the translate seat.
 * @returns the steps, oldest first.
 */
function stepsOf(task: Task, t: Translate): ChainStep[] {
  return task.nodes.map(node => {
    const at = Date.parse(node.at)
    return {
      key: node.id,
      kind: node.kind,
      title: nodeTitle(node, t),
      detail: node.detail,
      ok: node.ok,
      at: Number.isFinite(at) ? at : 0,
      ...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
      ...(node.failure === undefined ? {} : { failure: node.failure }),
    }
  })
}

/** 这条任务最后一次分类落在哪一类；没有分类节点时退到规则标签。 */
function labelOf(task: Task): string {
  const classify = task.nodes.find(node => node.kind === 'classify')
  const label = classify?.data?.['label']
  if (typeof label === 'string' && label !== '') return label
  const rule = task.nodes.find(node => node.kind === 'rule')
  const ruleLabel = rule?.data?.['label']
  return typeof ruleLabel === 'string' ? ruleLabel : ''
}

/**
 * 一次失败该由谁来收场。
 * @param failure - the kind the engine recorded, when it recorded one.
 * @returns what the page may offer.
 */
export function remedyOf(failure: RunFailure | undefined): Remedy {
  switch (failure) {
    case 'config': return 'fix-config'
    case 'transient': return 'retry'
    // 没标性质的失败按「只能承认」处理：给一个点不动的按钮比不给更糟。
    default: return 'none'
  }
}

/** 归档可以按哪个维度分组。 */
export type ArchiveDimension = 'outcome' | 'source' | 'rule' | 'day'

/** 维度在界面上出现的顺序。 */
export const ARCHIVE_DIMENSIONS: readonly ArchiveDimension[] = ['outcome', 'source', 'rule', 'day']

/** 归档里的一组任务。 */
export interface ArchiveGroup {
  readonly key: string
  /** 组名，已经本地化。 */
  readonly label: string
  readonly tasks: readonly TaskChain[]
}

/** 一个维度的名字。 */
export function dimensionLabel(dimension: ArchiveDimension, t: Translate): string {
  switch (dimension) {
    case 'outcome': return t('archiveDimOutcome')
    case 'source': return t('archiveDimSource')
    case 'rule': return t('archiveDimRule')
    default: return t('archiveDimDay')
  }
}

/** `2026-11-09`，按本机时区。 */
function dayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${String(date.getDate()).padStart(2, '0')}`
}

/** 一天叫什么：今天 / 昨天 / 具体日期。 */
function dayLabel(at: number, now: number, t: Translate): string {
  const today = dayKey(now)
  if (dayKey(at) === today) return t('dayToday')
  if (dayKey(at) === dayKey(now - 24 * 60 * 60 * 1000)) return t('dayYesterday')
  return dayKey(at)
}

/**
 * 把归档的任务按一个维度分组。
 *
 * 维度只是**同批数据的不同切法**，所以它是这个函数的一个参数，不是四份实现：
 * 每个维度自己决定「怎么归类」和「这一类排第几」，剩下的分桶与排序共用。
 * @param tasks - the archived tasks, any order.
 * @param dimension - how to split them.
 * @param t - the translate seat.
 * @param now - the reading moment, so "today" means one thing per render.
 * @returns the non-empty groups, in the dimension's own order.
 */
export function groupArchived(
  tasks: readonly TaskChain[],
  dimension: ArchiveDimension,
  t: Translate,
  now = Date.now(),
): readonly ArchiveGroup[] {
  const buckets = new Map<string, { label: string; rank: number; tasks: TaskChain[] }>()
  /** 收一个任务进某组；`rank` 小的排前面。 */
  const put = (key: string, label: string, rank: number, task: TaskChain): void => {
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { label, rank, tasks: [task] })
    else bucket.tasks.push(task)
  }
  for (const task of tasks) {
    switch (dimension) {
      case 'outcome':
        put(
          task.failed ? 'failed' : task.acknowledged ? 'dismissed' : 'done',
          task.failed ? t('archiveFailed') : task.acknowledged ? t('archiveDismissed') : t('archiveDone'),
          task.failed ? 0 : task.acknowledged ? 1 : 2,
          task,
        )
        break
      case 'source':
        put(task.source, task.source, 0, task)
        break
      case 'rule': {
        // 命中分支的名字在分支节点里；没有分支节点的任务（工具发起的）归到「没有分支」。
        const ruleNode = task.tasks[0]?.nodes.find(node => node.kind === 'rule')
        const name = typeof ruleNode?.data?.['ruleName'] === 'string' ? ruleNode.data['ruleName'] : ''
        const rule = name === '' ? t('archiveNoRule') : name
        put(rule, rule, 0, task)
        break
      }
      default: {
        // 越新的日期排越前：`rank` 用负时间戳，就是「由新到旧」。
        put(dayKey(task.updatedAt), dayLabel(task.updatedAt, now, t), -task.updatedAt, task)
        break
      }
    }
  }
  return [...buckets.entries()]
    .sort(([, left], [, right]) => left.rank - right.rank || left.label.localeCompare(right.label))
    .map(([key, bucket]) => ({ key, label: bucket.label, tasks: bucket.tasks }))
}

/**
 * Fold hit records into tasks and place each one in a zone.
 *
 * A task is `running` when a session it opened is alive right now — that is the
 * only claim the data can back. Otherwise a failed action or a held suggestion
 * makes it `todo`; a task inside its archive window also stays `todo` so a
 * rhythm of "after 15 minutes" means what it says; everything else is
 * `archived`.
 * @param runs - the hit records, any order.
 * @param runningIds - sessions the Host says are working right now.
 * @param archiveAfterMs - how long a settled task keeps its board seat.
 * @param now - the reading moment, so the whole render agrees on "now".
 * @param t - the translate seat.
 * @returns the tasks, newest activity first.
 */
export function buildTasks(
  tasks: readonly Task[],
  runningIds: ReadonlySet<string>,
  archiveAfterMs: number,
  now: number,
  t: Translate,
): readonly TaskChain[] {
  const chains: TaskChain[] = []
  for (const task of tasks) {
    const steps = stepsOf(task, t)
    const failed = task.status === 'partial' || task.status === 'failed'
    const sessionAlive = steps.some(step => step.sessionId !== undefined && runningIds.has(step.sessionId))
    const updatedAt = steps.reduce((newestAt, step) => Math.max(newestAt, step.at), 0)
    const failure = steps.find(step => !step.ok)?.failure
    const acknowledged = task.acknowledged === true
    const settled = !failed && (task.status === 'done' || task.status === 'skipped' || task.status === 'undone')
    // 「我看到了」优先于一切：人已经把它从待办里拿走了，失败与节奏都不该再把它弹回来。
    const zone: TaskZone = sessionAlive ? 'running' : acknowledged ? 'archived' : settled && now - updatedAt >= archiveAfterMs ? 'archived' : 'todo'
    chains.push({
      key: task.id,
      tasks: [task],
      steps,
      zone,
      title: titleOf(task, t),
      source: sourceOf(task),
      label: labelOf(task),
      updatedAt,
      failed,
      remedy: remedyOf(failure),
      acknowledged,
      ...(failure === undefined ? {} : { failure }),
    })
  }
  return chains.sort((left, right) => right.updatedAt - left.updatedAt)
}

/* ─────────────────────────────── 端口 ─────────────────────────────── */

/** What the board needs from the page it is drawn on. */
export interface BoardFace {
  /** 任务链——看板唯一的真相（Host 折好的一份，页面不再聚合）。 */
  readonly tasks: () => readonly Task[]
  /** Sessions the Host says are working right now. */
  readonly running: () => readonly { readonly sessionId: string; readonly title: string }[]
  /** How long a settled task keeps its seat; from the stored preference. */
  readonly rhythm: () => ArchiveRhythm
  /** Persist a new archive rhythm. */
  readonly setRhythm: (rhythm: ArchiveRhythm) => void
  /** 撤销一个任务：窗口内取消，窗口外回滚。 */
  readonly undo: (taskId: string) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** Open a session in the conversation page, when the deployment composes one. */
  readonly openSession?: (sessionId: string) => { readonly ok: boolean; readonly message?: string }
  /** Whether {@link openSession} can reach a real service. */
  readonly canOpenSession?: () => boolean
  /** 这一档节奏对应的窗口毫秒数。 */
  readonly rhythmMs: (rhythm: ArchiveRhythm) => number
  /**
   * 记下「这些命中记录我看到了」，或撤销这个标记。
   *
   * 一次任务可能由多次命中组成，所以按 id 列表收：只标记一部分会让它下次又冒出来。
   */
  readonly acknowledge: (runIds: readonly string[], acknowledged: boolean) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** 跳到规则页：配置错唯一的出路是改规则。 */
  readonly openRules: () => void
}

/** What the board shows when the engine cannot be read. */
export function WorkbenchUnavailable({ t }: { readonly t: Translate }): ReactNode {
  return <p className={CLS.empty}>{t('boardMissing')}</p>
}

/* ─────────────────────────────── 视图 ─────────────────────────────── */

/** Everything one board read produced. */
interface BoardData {
  readonly tasks: readonly TaskChain[]
  readonly loaded: boolean
  readonly error: string
}

/** How often the page re-reads the hit records while the board is open. */
const POLL_MS = 5000

/** 一次读的结果加上「现在再读一次」。 */
export interface BoardRead {
  readonly data: BoardData
  /**
   * 立刻重读，不等下一次轮询。
   *
   * 一次点击改了数据以后必须用它：轮询是给「别人做的事」看的，自己刚做的事要当场
   * 看见，否则按钮点下去到页面变样之间那几秒就是「卡住了」。
   */
  readonly reload: () => void
}

/**
 * Read the hit records and fold them into tasks.
 *
 * A poll rather than a stream: `runs.json` is written by the engine when an
 * action finishes, so the page only ever needs "what has it done since I last
 * looked". Five seconds is short enough to see a chain grow and long enough that
 * an idle board costs nothing noticeable — and a write the page itself made
 * re-reads immediately through {@link BoardRead.reload}.
 * @param face - the engine, the session roster and the stored rhythm.
 * @param t - the translate seat.
 * @returns the snapshot, plus whether a read has ever landed.
 */
export function useBoardData(face: BoardFace, t: Translate): BoardRead {
  const [data, setData] = useState<BoardData>({ tasks: [], loaded: false, error: '' })
  /** 每加一次就跑一遍读：手动刷新走它，不必等定时器。 */
  const [generation, setGeneration] = useState(0)
  // Read through refs so a new render's closures never restart the timer; the
  // rhythm is the one input that must re-read, because it changes the zones.
  const faceRef = useRef(face)
  faceRef.current = face
  const tRef = useRef(t)
  tRef.current = t
  const rhythm = face.rhythm()
  useEffect(() => {
    let disposed = false
    const read = (): void => {
      try {
        const tasks = faceRef.current.tasks()
        if (disposed) return
        const runningIds = new Set(faceRef.current.running().map(session => session.sessionId))
        setData({
          tasks: buildTasks(
            tasks,
            runningIds,
            faceRef.current.rhythmMs(faceRef.current.rhythm()),
            Date.now(),
            tRef.current,
          ),
          loaded: true,
          error: '',
        })
      } catch {
        // 读不到与「还没有任何任务」是两件事：前者是故障，后者是正常的空。
        if (disposed) return
        setData(current => ({ ...current, loaded: true, error: tRef.current('boardMissing') }))
      }
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [rhythm, generation])
  return {
    data,
    reload: () => { setGeneration(current => current + 1) },
  }
}

/**
 * Draw the board.
 *
 * One read, three zones. The read is a hook the page owns (`useBoardData`),
 * because the modal and the zone counts must agree on the same snapshot.
 * @param props.face - the engine and the session roster.
 * @param props.t - the translate seat.
 * @param props.data - the snapshot the page already read.
 * @returns the zones.
 */
export function BoardView(props: {
  readonly face: BoardFace
  readonly t: Translate
  readonly data: BoardData
  /** 自己刚改过数据时立刻重读；不传就只跟轮询（spec 面用得上）。 */
  readonly reload?: () => void
}): ReactNode {
  const { t, data } = props
  const [openKey, setOpenKey] = useState<string | undefined>(undefined)
  const [archiveOpen, setArchiveOpen] = useState(false)
  /** 归档里哪一组被展开；默认都收着——展开归档是为了找，不是为了再滚一遍。 */
  const [openedGroups, setOpenedGroups] = useState<Readonly<Record<string, boolean>>>({})
  /** 归档按哪个维度分组；换维度只重排同一批数据，不动任何记录。 */
  const [archiveDimension, setArchiveDimension] = useState<ArchiveDimension>('outcome')
  /** 正在等哪一条任务的写请求回来：那一张卡的按钮先锁住，免得连点。 */
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState('')
  if (!data.loaded) return <p className={CLS.empty}>{t('boardLoading')}</p>
  if (data.error !== '') return <p className={CLS.empty}>{data.error}</p>
  if (data.tasks.length === 0) return <p className={CLS.empty}>{t('boardEmpty')}</p>

  const open = data.tasks.find(task => task.key === openKey)
  const zone = (which: TaskZone): readonly TaskChain[] => data.tasks.filter(task => task.zone === which)
  const todo = zone('todo')
  const running = zone('running')
  const archived = zone('archived')

  /**
   * 把一个任务的全部命中记录一起标记/取消标记，写完立刻重读。
   *
   * 重读是必须的：不然按钮点下去到页面变样之间要等下一次轮询（最多五秒），
   * 那五秒就是用户说的「卡」。
   */
  const acknowledge = (task: TaskChain, value: boolean): void => {
    setBusyKey(task.key)
    void props.face.acknowledge(task.tasks.map(item => item.id), value)
      .then((result) => {
        setFailure(result.ok ? '' : result.message ?? t('boardActionFailed'))
        if (result.ok) props.reload?.()
      })
      .finally(() => { setBusyKey(undefined) })
  }

  return (
    <div className={CLS.board}>
      <div className={CLS.statusBar} role="group" aria-label={t('boardTitle')}>
        <Stat label={t('boardStatTodo')} value={todo.length} dot={todo.some(task => task.failed) ? 'error' : 'idle'} />
        <Stat label={t('boardStatRunning')} value={running.length} dot="ongoing" />
        <Stat label={t('boardStatDone')} value={archived.length} dot="done" />
      </div>
      {failure === '' ? null : <p className={CLS.boardFailure} role="status">{failure}</p>}
      <RhythmRow face={props.face} t={t} />
      <div className={running.length === 0 ? CLS.boardColumns : `${CLS.boardColumns} ${CLS.boardColumnsLive}`}>
        <Zone
          zone="todo"
          title={t('boardTodo')}
          hint={t('boardTodoHint')}
          tasks={todo}
          empty={t('boardTodoEmpty')}
          t={t}
          onOpen={setOpenKey}
          onAck={task => { acknowledge(task, true) }}
          onRules={props.face.openRules}
          busyKey={busyKey}
        />
        <Zone
          zone="running"
          title={t('boardProcessing')}
          hint={t('boardProcessingHint')}
          tasks={running}
          empty={t('boardProcessingEmpty')}
          t={t}
          onOpen={setOpenKey}
          onAck={task => { acknowledge(task, true) }}
          onRules={props.face.openRules}
          busyKey={busyKey}
        />
      </div>
      {archived.length === 0 ? null : (
        <DisclosureRow
          icon={<IconChevronDownOutlineRegular />}
          title={`${t('boardArchive')} · ${String(archived.length)}`}
          expandable
          expandOnRowClick
          open={archiveOpen}
          onToggle={() => { setArchiveOpen(value => !value) }}
        >
          <p className={CLS.viewMeta}>{t('boardArchiveHint')}</p>
          <div className={CLS.dimRow} role="group" aria-label={t('archiveBy')}>
            <span className={CLS.dimLabel}>{t('archiveBy')}</span>
            {ARCHIVE_DIMENSIONS.map(dimension => (
              <Pill
                key={dimension}
                active={dimension === archiveDimension}
                onClick={() => { setArchiveDimension(dimension) }}
              >
                {dimensionLabel(dimension, t)}
              </Pill>
            ))}
          </div>
          {(() => {
            const groups = groupArchived(archived, archiveDimension, t)
            // 只有一组时不再套一层折叠：底下就一种东西，再点一下才看得见是白费的。
            if (groups.length <= 1) {
              return (
                <TaskList
                  tasks={archived}
                  t={t}
                  onOpen={setOpenKey}
                  onAck={task => { acknowledge(task, false) }}
                  onRules={props.face.openRules}
                  archived
                />
              )
            }
            return (
              <div className={CLS.archiveGroups}>
                {groups.map(group => (
                  <DisclosureRow
                    key={group.key}
                    icon={<IconChevronDownOutlineRegular />}
                    title={`${group.label} · ${String(group.tasks.length)}`}
                    expandable
                    expandOnRowClick
                    open={openedGroups[group.key] === true}
                    onToggle={() => {
                      setOpenedGroups(current => ({
                        ...current,
                        [group.key]: !(current[group.key] ?? false),
                      }))
                    }}
                  >
                    <TaskList
                      tasks={group.tasks}
                      t={t}
                      onOpen={setOpenKey}
                      onAck={task => { acknowledge(task, false) }}
                      onRules={props.face.openRules}
                      archived
                    />
                  </DisclosureRow>
                ))}
              </div>
            )
          })()}
        </DisclosureRow>
      )}
      <p className={CLS.boardHint}>{t('boardHint')}</p>
      {open === undefined ? null : (
        <TaskDetail
          task={open}
          t={t}
          face={props.face}
          onClose={() => { setOpenKey(undefined) }}
          onFailure={message => { setFailure(message) }}
          onAck={value => { acknowledge(open, value) }}
        />
      )}
    </div>
  )
}

/** One zone: a heading, one line of explanation, then the cards. */
function Zone(props: {
  readonly zone: TaskZone
  readonly title: string
  readonly hint: string
  readonly tasks: readonly TaskChain[]
  readonly empty: string
  readonly t: Translate
  readonly onOpen: (key: string) => void
  readonly onAck: (task: TaskChain) => void
  readonly onRules: () => void
  readonly busyKey?: string | undefined
}): ReactNode {
  return (
    <section className={CLS.column} aria-label={props.title} data-zone={props.zone}>
      <header className={CLS.columnHead}>
        <div className={CLS.columnTitleRow}>
          <StateDot state={props.zone === 'running' ? 'ongoing' : 'idle'} />
          <h3 className={CLS.columnTitle}>{props.title}</h3>
          <span className={CLS.columnCount}>{props.tasks.length}</span>
        </div>
        <p className={CLS.columnHint}>{props.hint}</p>
      </header>
      {props.tasks.length === 0
        ? <p className={CLS.columnEmpty}>{props.empty}</p>
        : (
          <TaskList
            tasks={props.tasks}
            t={props.t}
            onOpen={props.onOpen}
            onAck={props.onAck}
            onRules={props.onRules}
            grid
            {...(props.busyKey === undefined ? {} : { busyKey: props.busyKey })}
          />
        )}
    </section>
  )
}

/** The cards of one zone. */
function TaskList(props: {
  readonly tasks: readonly TaskChain[]
  readonly t: Translate
  readonly onOpen: (key: string) => void
  readonly onAck: (task: TaskChain) => void
  readonly onRules: () => void
  /** 归档区里的卡：「忽略」变成「恢复」，因为它们本来就不在待办里。 */
  readonly archived?: boolean
  /** 待办/进行中铺成网格：一列八百多像素太宽，一行读下来眼睛要跑。 */
  readonly grid?: boolean
  /** 正在等写请求的那一条：它的按钮先锁住。 */
  readonly busyKey?: string
}): ReactNode {
  return (
    <ul className={props.grid === true ? CLS.cardsGrid : CLS.cardsList}>
      {props.tasks.map((task) => {
        const last = task.steps[task.steps.length - 1]
        const busy = props.busyKey === task.key
        return (
          <li key={task.key} className={CLS.taskCard}>
            <button
              type="button"
              className={CLS.taskCardOpen}
              onClick={() => { props.onOpen(task.key) }}
              aria-label={task.title}
            >
              <span className={CLS.taskCardHead}>
                <span className={CLS.taskCardTitle}>{task.title}</span>
                <span className={CLS.taskCardMeta}>
                  <Tag tone="quiet">{task.source}</Tag>
                  {task.label === '' ? null : <Tag tone="info">{task.label}</Tag>}
                  <RemedyBadge task={task} t={props.t} />
                </span>
              </span>
              <ChainLine steps={task.steps} t={props.t} compact />
              <span className={CLS.taskCardFoot}>
                <span className={CLS.taskCardHint}>
                  {props.t('linkStepCount', { count: task.steps.length })}
                </span>
                {last === undefined ? null : (
                  <span className={CLS.taskCardHint}>{new Date(task.updatedAt).toLocaleTimeString()}</span>
                )}
              </span>
            </button>
            <span className={CLS.taskCardActions}>
              {task.remedy === 'fix-config' && (
                <Button size="sm" variant="ghost" onClick={props.onRules}>{props.t('remedyFixConfig')}</Button>
              )}
              {props.archived === true
                ? (task.acknowledged && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { props.onAck(task) }}>
                    {props.t('remedyRestore')}
                  </Button>
                ))
                : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { props.onAck(task) }}>
                    {props.t('remedyDismiss')}
                  </Button>
                )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** 失败的性质，一句话说清人该做什么；没失败就不画。 */
function RemedyBadge(props: { readonly task: TaskChain; readonly t: Translate }): ReactNode {
  if (!props.task.failed) {
    return <StateDot state={props.task.zone === 'running' ? 'ongoing' : 'done'} />
  }
  // 老记录没有性质：说「失败」是诚实的，说「目标已失效」是替它编一个原因。
  if (props.task.failure === undefined) {
    return <Tag tone="danger">{props.t('boardStatFailed')}</Tag>
  }
  switch (props.task.remedy) {
    case 'fix-config':
      return <Tag tone="info">{props.t('remedyConfig')}</Tag>
    case 'retry':
      return <Tag tone="danger">{props.t('remedyTransient')}</Tag>
    default:
      return <Tag tone="danger">{props.t('remedyFatal')}</Tag>
  }
}

/**
 * The chain itself: a vertical run of steps joined by a hairline.
 *
 * Not a graph library and not a canvas: the chain is a sequence, and a sequence
 * is a column of dots with a line between them. `StateDot appearance="step"`
 * already carries the completed/pending semantics.
 * @param props.steps - the steps, oldest first.
 * @param props.t - the translate seat.
 * @param props.compact - true when drawn inside a card (names only, no detail).
 * @returns the chain.
 */
export function ChainLine(props: {
  readonly steps: readonly ChainStep[]
  readonly t: Translate
  readonly compact?: boolean
}): ReactNode {
  return (
    <ol className={CLS.chain}>
      {props.steps.map((step) => (
        <li
          key={step.key}
          className={step.ok ? CLS.chainStep : `${CLS.chainStep} ${CLS.chainStepFailed}`}
        >
          <span className={CLS.chainGlyph} aria-hidden="true">
            <StateDot
              state={step.ok ? 'done' : 'error'}
              {...(step.sessionId === undefined ? {} : { appearance: 'step' as const })}
            />
          </span>
          <span className={CLS.chainBody}>
            <span className={CLS.chainName}>
              {step.kind === 'rule' ? `${props.t('linkRule')}·` : ''}{step.title}
            </span>
            {props.compact === true || step.detail === '' ? null : (
              <span className={CLS.chainDetail}>{step.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The archive-rhythm picker: four one-click choices, the current one marked. */
function RhythmRow(props: { readonly face: BoardFace; readonly t: Translate }): ReactNode {
  const current = props.face.rhythm()
  const options: readonly ArchiveRhythm[] = ['immediate', 'fifteen', 'hour', 'day']
  const labelOf = (rhythm: ArchiveRhythm): string => {
    switch (rhythm) {
      case 'immediate': return props.t('archiveImmediate')
      case 'fifteen': return props.t('archiveFifteen')
      case 'hour': return props.t('archiveHour')
      case 'day': return props.t('archiveDay')
    }
  }
  return (
    <div className={CLS.rhythmRow} role="group" aria-label={props.t('archiveRhythm')}>
      <span className={CLS.rhythmLabel}>{props.t('archiveRhythm')}</span>
      {options.map(rhythm => (
        <Button
          key={rhythm}
          size="sm"
          variant={rhythm === current ? 'primary' : 'ghost'}
          onClick={() => { props.face.setRhythm(rhythm) }}
        >
          {labelOf(rhythm)}
        </Button>
      ))}
    </div>
  )
}

/** The task detail: the full chain, the trigger, and the one action a human owes. */
function TaskDetail(props: {
  readonly task: TaskChain
  readonly t: Translate
  readonly face: BoardFace
  readonly onClose: () => void
  readonly onFailure: (message: string) => void
  readonly onAck: (acknowledged: boolean) => void
}): ReactNode {
  const { t, task } = props
  const canOpen = props.face.canOpenSession?.() === true
  const sessions = task.steps.filter(step => step.sessionId !== undefined)
  return (
    <Modal open onClose={props.onClose} title={t('detailTitle')} closeLabel={t('detailClose')}>
      <div className={CLS.detail}>
        <header className={CLS.detailHead}>
          <h3 className={CLS.detailTitle}>{task.title}</h3>
          <div className={CLS.detailMeta}>
            <Tag tone="quiet">{task.source}</Tag>
            {task.label === '' ? null : <Tag tone="info">{task.label}</Tag>}
            
            {task.failed && <Tag tone="danger">{t('boardStatFailed')}</Tag>}
          </div>
        </header>
        <section>
          <h4 className={CLS.detailSection}>{t('detailEvent')}</h4>
          <ul className={CLS.detailEvents}>
            {task.tasks.map(item => (
              <li key={item.id} className={CLS.detailEventRow}>
                <span className={CLS.detailEventAt}>{new Date(Date.parse(item.at)).toLocaleString()}</span>
                <span className={CLS.detailEventText}>{item.title}</span>
                <span className={CLS.detailEventRule}>{item.connector}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h4 className={CLS.detailSection}>{t('detailChain')}</h4>
          {task.steps.length === 0
            ? <p className={CLS.empty}>{t('detailNoActions')}</p>
            : <ChainLine steps={task.steps} t={t} />}
        </section>
        {task.failed && task.failure !== undefined && (
          <p className={CLS.detailNote}>
            {task.remedy === 'fix-config'
              ? t('remedyFixHint')
              : task.remedy === 'retry' ? t('remedyRetryHint') : t('remedyFatalHint')}
          </p>
        )}
        <div className={CLS.detailActions}>
          {canOpen && sessions.map(step => (
            <Button
              key={step.key}
              size="sm"
              variant="outline"
              onClick={() => {
                const answer = props.face.openSession?.(step.sessionId as string)
                if (answer !== undefined && !answer.ok) {
                  props.onFailure(answer.message ?? t('linkSessionGone'))
                }
              }}
            >
              {t('linkOpenSession')}
            </Button>
          ))}
          {task.remedy === 'fix-config' && (
            <Button size="sm" variant="ghost" onClick={props.face.openRules}>{t('remedyFixConfig')}</Button>
          )}
          {task.acknowledged
            ? <Button size="sm" variant="ghost" onClick={() => { props.onAck(false) }}>{t('remedyRestore')}</Button>
            : <Button size="sm" variant="outline" onClick={() => { props.onAck(true) }}>{t('remedyDismiss')}</Button>}
        </div>
      </div>
    </Modal>
  )
}

/**
 * The board page: the read, then the draw.
 *
 * A component rather than a hook called inside the shell, because a hook at the
 * shell's top level would poll the engine even while the user is on another
 * view. Mounting is the thing that turns the poll on.
 * @param props.face - the engine and the session roster.
 * @param props.t - the translate seat.
 * @returns the board.
 */
export function BoardPage(props: { readonly face: BoardFace; readonly t: Translate }): ReactNode {
  const { data, reload } = useBoardData(props.face, props.t)
  return <BoardView face={props.face} t={props.t} data={data} reload={reload} />
}

/** One figure in the strip: dot, number, name. */
function Stat(props: {
  readonly label: string
  readonly value: number
  readonly dot: 'idle' | 'ongoing' | 'done' | 'error'
}): ReactNode {
  return (
    <div className={CLS.stat}>
      <StateDot state={props.dot} />
      <span className={CLS.statValue}>{props.value}</span>
      <span className={CLS.statLabel}>{props.label}</span>
    </div>
  )
}

export type { BoardData }
