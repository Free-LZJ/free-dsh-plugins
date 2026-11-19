/**
 * SQLite 实现。**存储层的一个具体实现**，不是一个独立的数据世界。
 *
 * 与 `store.ts` 里的 JSON 实现共用同一个 `TaskStore` 接口，宿主（引擎）只认接口，
 * 不认哪一种。选择发生在 `openTaskStore`：能用 SQLite 就用，拿不到就回落 JSON。
 *
 * 形状是「索引列 + 整条任务文档」：
 * - `id/key/event_key/connector/status/updated_at/acknowledged` 提成列，因为看板要
 *   按状态、时间过滤和排序，这些查询不该把整库读进内存；
 * - 任务本体（含节点链）存一列 JSON：节点只追加、整条读，没有跨节点查询的需求，
 *   拆表反而多一轮 join。
 *
 * 收益在写这一侧：追加一格节点从「重写整份文件」变成一条 `UPDATE`，裁剪从「读全部
 * 再写全部」变成一条 `DELETE`。
 *
 * @module @free-lzj/dsh-decision/task/sqlite-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodePatch, Task, TaskNodeRecord, TaskPatch } from './record.ts'
import type { TaskStore } from './store.ts'

const STATUSES: ReadonlySet<string> = new Set(['running', 'suspended', 'done', 'partial', 'skipped', 'failed', 'undone'])

/**
 * 造一个 SQLite 任务仓。
 * @param dir - 数据目录（DB 文件是 `tasks.db`）。
 * @param log - 日志出口。
 * @returns 仓储。
 */
export async function createSqliteTaskStore(dir: string, log: (line: string) => void): Promise<TaskStore> {
  // 延迟取 node:sqlite：它是实验特性，不同宿主运行时不一定有。放在这里，
  // 整个包加载时不会因为缺它而崩，探测失败只是回落。
  const { DatabaseSync } = await import('node:sqlite')
  const file = join(dir, 'tasks.db')
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      event_key TEXT,
      connector TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      doc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS tasks_key ON tasks(key);
    CREATE INDEX IF NOT EXISTS tasks_event ON tasks(event_key);
  `)

  /** 把一条任务写成一行。已存在则覆盖。 */
  const put = (task: Task): void => {
    db.prepare(`
      INSERT INTO tasks (id, key, event_key, connector, status, updated_at, acknowledged, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key, event_key = excluded.event_key, connector = excluded.connector,
        status = excluded.status, updated_at = excluded.updated_at,
        acknowledged = excluded.acknowledged, doc = excluded.doc
    `).run(
      task.id, task.key, task.eventKey ?? null, task.connector, task.status, task.updatedAt,
      task.acknowledged === true ? 1 : 0, JSON.stringify(task),
    )
  }

  /** 读一行；坏 JSON 当作不存在。 */
  const read = (row: { doc?: unknown } | undefined): Task | undefined => {
    if (row === undefined || typeof row.doc !== 'string') return undefined
    try {
      return JSON.parse(row.doc) as Task
    } catch {
      return undefined
    }
  }

  const one = (sql: string, value: string): Task | undefined =>
    read(db.prepare(sql).get(value) as { doc?: unknown } | undefined)

  const store: TaskStore = {
    async load() {
      // 空库 + 有旧 JSON：一次性灌进来。旧文件不删。
      const legacy = join(dir, 'tasks.json')
      const count = Number((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n)
      if (count > 0 || !existsSync(legacy)) return
      try {
        const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as { tasks?: readonly Task[] }
        const list = Array.isArray(parsed.tasks) ? parsed.tasks : []
        for (const task of list) {
          if (typeof task?.id === 'string' && STATUSES.has(task.status)) put(task)
        }
        if (list.length > 0) log(`任务仓: 已从 tasks.json 导入 ${String(list.length)} 条到 tasks.db（旧文件保留）`)
      } catch {
        log('任务仓: tasks.json 读不动，跳过导入')
      }
    },
    list() {
      const rows = db.prepare('SELECT doc FROM tasks ORDER BY updated_at DESC').all() as { doc?: unknown }[]
      return rows.map(read).filter((task): task is Task => task !== undefined)
    },
    get: id => one('SELECT doc FROM tasks WHERE id = ?', id),
    byKey: key => one('SELECT doc FROM tasks WHERE key = ? ORDER BY updated_at DESC LIMIT 1', key),
    byEventKey: key => one('SELECT doc FROM tasks WHERE event_key = ? ORDER BY updated_at DESC LIMIT 1', key),
    async create(task) {
      const existing = store.get(task.id)
      if (existing !== undefined) return existing
      put(task)
      return task
    },
    async appendNode(taskId, node: TaskNodeRecord) {
      const task = store.get(taskId)
      if (task === undefined) return undefined
      const next: Task = { ...task, nodes: [...task.nodes, node], updatedAt: node.at }
      put(next)
      return next
    },
    async patchNode(taskId: string, nodeId: string, patch: NodePatch) {
      const task = store.get(taskId)
      if (task === undefined) return undefined
      const nodes = task.nodes.map(node => (node.id === nodeId ? { ...node, ...patch } : node))
      const next: Task = { ...task, nodes }
      put(next)
      return next
    },
    async patch(taskId: string, patch: TaskPatch) {
      const task = store.get(taskId)
      if (task === undefined) return undefined
      const next: Task = {
        ...task,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.awaitingConfirmation === undefined ? {} : { awaitingConfirmation: patch.awaitingConfirmation }),
        ...(patch.acknowledged === undefined ? {} : { acknowledged: patch.acknowledged }),
        ...(patch.undoableUntil === undefined ? {} : { undoableUntil: patch.undoableUntil }),
        ...(patch.progress === undefined ? {} : { progress: patch.progress }),
        ...(patch.runId === undefined ? {} : { runId: patch.runId }),
        ...(patch.updatedAt === undefined ? {} : { updatedAt: patch.updatedAt }),
      }
      put(next)
      return next
    },
    async importTasks(tasks) {
      let added = 0
      for (const task of tasks) {
        if (store.get(task.id) !== undefined) continue
        put(task)
        added += 1
      }
      return added
    },
    async trim({ limit, days }, now) {
      if (days > 0) {
        const floor = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
        db.prepare('DELETE FROM tasks WHERE updated_at < ?').run(floor)
      }
      if (limit > 0) {
        // 留**最新**的 limit 条：顺序由 SQL 决定，不靠数组次序。
        db.prepare(`
          DELETE FROM tasks WHERE id NOT IN (
            SELECT id FROM tasks ORDER BY updated_at DESC LIMIT ?
          )
        `).run(limit)
      }
    },
    count: () => Number((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n),
  }
  return store
}
