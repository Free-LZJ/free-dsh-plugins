/**
 * 任务仓：`tasks.json` 的读写。
 *
 * 只做存储，不做判断。三个刻意的取舍：
 *
 * 1. **按字段重建**而不是把磁盘对象整个展开：旧版本写下的键不会跟着混进下一次落盘，
 *    记录的形状只有这一个来源。
 * 2. **认不出的记录丢掉**而不是让整份文件作废：一条坏记录不该让用户的历史全没。
 * 3. **写是串行的**（`serialWriter`）：一次 `emit` 可能同时追加几格，乱序写会把后
 *    面的覆盖成前面的。
 *
 * @module @free-lzj/dsh-decision/task/store
 */

import { readJson, serialWriter } from '../store.ts'
import type { NodePatch, Task, TaskNodeRecord, TaskPatch, TaskStatus } from './record.ts'

/** `tasks.json` 的形状。 */
interface TasksFile {
  readonly version: 1
  readonly tasks: readonly Task[]
}

/** 仓的接口。 */
export interface TaskStore {
  /** 从磁盘读；坏文件回落成空历史。 */
  load(): Promise<void>
  /** 最新活动在前。 */
  list(): readonly Task[]
  get(id: string): Task | undefined
  /** 按任务身份找（同一件事的后续事件归到它）。 */
  byKey(key: string): Task | undefined
  /** 按事件身份找（`dedupeKey` 命中时用）。 */
  byEventKey(eventKey: string): Task | undefined
  /** 建一个任务并落盘。 */
  create(task: Task): Promise<Task>
  /** 追加一格；返回更新后的任务。 */
  appendNode(taskId: string, node: TaskNodeRecord): Promise<Task | undefined>
  /** 就地改一格（会话状态回写、延迟动作回填结果）。 */
  patchNode(taskId: string, nodeId: string, patch: NodePatch): Promise<Task | undefined>
  /** 就地改任务状态。 */
  patch(taskId: string, patch: TaskPatch): Promise<Task | undefined>
  /** 一次性导入迁移出来的任务（已存在同 id 的跳过）。 */
  importTasks(tasks: readonly Task[]): Promise<number>
  /** 按保留策略裁剪并落盘。 */
  trim(options: { readonly limit: number; readonly days: number }, now: Date): Promise<void>
  /** 现在的任务数（迁移要不要跑据此判断）。 */
  count(): number
}

const STATUSES: ReadonlySet<TaskStatus> = new Set(['running', 'done', 'partial', 'skipped', 'failed', 'undone'])

/**
 * 认回一条任务；缺关键字段就返回 undefined。
 * @param value - 磁盘上的原始对象。
 * @returns 任务，或 undefined（这条不可信）。
 */
function parseTask(value: unknown): Task | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const task = value as Record<string, unknown>
  if (typeof task['id'] !== 'string' || typeof task['key'] !== 'string') return undefined
  if (typeof task['connector'] !== 'string' || typeof task['triggerId'] !== 'string') return undefined
  if (typeof task['title'] !== 'string' || typeof task['at'] !== 'string') return undefined
  if (!Array.isArray(task['nodes'])) return undefined
  if (typeof task['event'] !== 'object' || task['event'] === null) return undefined
  const status = task['status']
  return {
    id: task['id'],
    connector: task['connector'],
    triggerId: task['triggerId'],
    key: task['key'],
    title: task['title'],
    at: task['at'],
    updatedAt: typeof task['updatedAt'] === 'string' ? task['updatedAt'] : task['at'],
    status: typeof status === 'string' && STATUSES.has(status as TaskStatus) ? status as TaskStatus : 'done',
    nodes: task['nodes'] as readonly TaskNodeRecord[],
    event: task['event'] as Task['event'],
    vars: (typeof task['vars'] === 'object' && task['vars'] !== null ? task['vars'] : {}) as Task['vars'],
    ...(typeof task['eventKey'] === 'string' ? { eventKey: task['eventKey'] } : {}),
    ...(task['awaitingConfirmation'] === true ? { awaitingConfirmation: true } : {}),
    ...(task['acknowledged'] === true ? { acknowledged: true } : {}),
    ...(typeof task['undoableUntil'] === 'string' ? { undoableUntil: task['undoableUntil'] } : {}),
  }
}

/**
 * 打开任务仓。
 * @param path - `tasks.json` 的绝对路径；测试指到临时目录。
 * @returns 仓。
 */
export function createTaskStore(path: string): TaskStore {
  const write = serialWriter()
  let tasks: Task[] = []

  const parseFile = (value: unknown): TasksFile | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const file = value as { version?: unknown; tasks?: unknown }
    if (file.version !== 1 || !Array.isArray(file.tasks)) return undefined
    return {
      version: 1,
      tasks: file.tasks.map(parseTask).filter((task): task is Task => task !== undefined),
    }
  }

  /** 落盘一次；最新的任务在前。 */
  async function persist(): Promise<void> {
    await write(path, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)
  }

  /** 就地换一条任务；找不到返回 undefined。 */
  function replace(taskId: string, change: (current: Task) => Task): Task | undefined {
    const index = tasks.findIndex(task => task.id === taskId)
    const current = tasks[index]
    if (current === undefined) return undefined
    const updated = change(current)
    tasks = [...tasks.slice(0, index), updated, ...tasks.slice(index + 1)]
    return updated
  }

  return {
    async load() {
      const file = await readJson<TasksFile>(path, parseFile, { version: 1, tasks: [] })
      tasks = [...file.tasks]
    },
    list: () => [...tasks],
    get: id => tasks.find(task => task.id === id),
    byKey: key => tasks.find(task => task.key === key),
    byEventKey: eventKey => tasks.find(task => task.eventKey === eventKey),
    async create(task) {
      tasks = [task, ...tasks]
      await persist()
      return task
    },
    async appendNode(taskId, node) {
      const updated = replace(taskId, current => ({
        ...current,
        nodes: [...current.nodes, node],
        updatedAt: node.at,
      }))
      if (updated !== undefined) await persist()
      return updated
    },
    async patchNode(taskId, nodeId, patch) {
      const updated = replace(taskId, current => ({
        ...current,
        nodes: current.nodes.map(node => node.id === nodeId
          ? {
              ...node,
              ...(patch.detail === undefined ? {} : { detail: patch.detail }),
              ...(patch.ok === undefined ? {} : { ok: patch.ok }),
              ...(patch.failure === undefined ? {} : { failure: patch.failure }),
              ...(patch.data === undefined ? {} : { data: { ...node.data, ...patch.data } }),
            }
          : node),
        updatedAt: new Date().toISOString(),
      }))
      if (updated !== undefined) await persist()
      return updated
    },
    async patch(taskId, patch) {
      const updated = replace(taskId, current => ({
        ...current,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.awaitingConfirmation === undefined ? {} : { awaitingConfirmation: patch.awaitingConfirmation }),
        ...(patch.acknowledged === undefined ? {} : { acknowledged: patch.acknowledged }),
        ...(patch.undoableUntil === undefined ? {} : { undoableUntil: patch.undoableUntil }),
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      }))
      if (updated !== undefined) await persist()
      return updated
    },
    async importTasks(imported) {
      const known = new Set(tasks.map(task => task.id))
      const fresh = imported.filter(task => !known.has(task.id))
      if (fresh.length === 0) return 0
      tasks = [...tasks, ...fresh].sort((left, right) => right.at.localeCompare(left.at))
      await persist()
      return fresh.length
    },
    async trim({ limit, days }, now) {
      // days: 0 是「不按天数裁」，不是「全部过期」——后者会把历史一次清空。
      const floor = days > 0 ? now.getTime() - days * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY
      // 顺序不能依赖数组现有次序：文件若是「旧在前」，`slice` 裁掉的就是**最新**的
      // （2026-11-11 真机踩到：44 条被裁成 2 条）。一律按 `updatedAt` 由新到旧再截。
      const ordered = tasks
        .filter(task => Date.parse(task.updatedAt) >= floor)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      // limit: 0 同样是「不限条数」，不是「全删」。
      const kept = limit > 0 ? ordered.slice(0, limit) : ordered
      if (kept.length === tasks.length) return
      tasks = kept
      await persist()
    },
    count: () => tasks.length,
  }
}

/**
 * 一个永远指向「当前实现」的门面。
 *
 * 存储实现在启动时才确定（有 SQLite 就用，没有回落 JSON），而 runner 在构造时
 * 已经拿到了引用。门面让「换实现」变成换一个内部指针，持有者不必知道。
 * @param current - 取当前实现。
 * @returns 同一个对象、转发到当前实现。
 */
export function forwardingStore(current: () => TaskStore): TaskStore {
  return {
    load: () => current().load(),
    list: () => current().list(),
    get: id => current().get(id),
    byKey: key => current().byKey(key),
    byEventKey: key => current().byEventKey(key),
    create: task => current().create(task),
    appendNode: (taskId, node) => current().appendNode(taskId, node),
    patchNode: (taskId, nodeId, patch) => current().patchNode(taskId, nodeId, patch),
    patch: (taskId, patch) => current().patch(taskId, patch),
    importTasks: tasks => current().importTasks(tasks),
    trim: (options, now) => current().trim(options, now),
    count: () => current().count(),
  }
}

/** 存储实现的名字，给日志与页面用。 */
export type TaskStoreKind = 'sqlite' | 'json'

/**
 * 打开任务仓：能上 SQLite 就上，拿不到就回落 JSON。
 *
 * 探测走**变量路径的动态 import**：`node:sqlite` 是实验特性，不同 Node/Electron
 * 运行时不一定有，而实现文件可能还没打包进这一版。任何失败都只是回落，绝不抛——
 * 一个跑不起来的数据层比慢一点的数据层糟得多。
 * @param input - 目录、兼容用文件路径、日志出口。
 * @returns 仓储实例与它实际用的实现。
 */
export async function openTaskStore(input: {
  readonly dir: string
  readonly file: string
  readonly log: (line: string) => void
}): Promise<{ readonly store: TaskStore; readonly kind: TaskStoreKind }> {
  try {
    // 先探驱动再建实现：驱动缺失时连模块都不必求值。
    await import('node:sqlite')
    const { createSqliteTaskStore } = await import('./sqlite-store.ts')
    return { store: await createSqliteTaskStore(input.dir, input.log), kind: 'sqlite' }
  } catch {
    // 运行时没有 node:sqlite（版本差、Electron 裁剪）——回落，绝不抛。
  }
  input.log('任务仓: SQLite 不可用，回落 JSON 文件（tasks.json）')
  return { store: createTaskStore(input.file), kind: 'json' }
}
