/**
 * 命中记录：它背着你做了什么。
 *
 * 这是整个插件里唯一一份**给人看的历史**，所以两件事以可读性为准：主题与发件人直接
 * 存下来（而不是只存 UID 让人去别处查），失败原因存成人话（而不是错误码）。
 *
 * 裁剪策略是「先按天数、再按条数」：只按条数裁会让「今天发生了 600 件事」把上周的
 * 记录挤掉；只按天数裁会让一次事故可以写下几万条。两者都设上限才收敛。
 *
 * @module @free-lzj/dsh-mail/triage/runs
 */

import { randomUUID } from 'node:crypto'
import { readJson, serialWriter } from './store.ts'
import type { Run, RunAction, RunStatus } from './types.ts'

/** `runs.json` 的形状。 */
interface RunsFile {
  readonly version: 1
  readonly runs: readonly Run[]
}

/** 一份命中记录的仓。 */
export interface RunStore {
  /** 从磁盘读；坏文件回落成空历史。 */
  load(): Promise<void>
  /** 最新的在前。 */
  list(): readonly Run[]
  /** 按 id 取一条。 */
  get(id: string): Run | undefined
  /** 追加一条并落盘；返回它。 */
  append(run: Omit<Run, 'id'> & { readonly id?: string }): Promise<Run>
  /** 就地把一条记录改成另一个状态（撤销用）。 */
  patch(id: string, change: { readonly status: RunStatus; readonly actions?: readonly RunAction[] }): Promise<Run | undefined>
  /** 按保留策略裁剪并落盘。 */
  trim(options: { readonly limit: number; readonly days: number }, now: Date): Promise<void>
}

/** 读一条记录；字段不全就当它不可信。 */
function parseRun(value: unknown): Run | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const run = value as Partial<Run>
  if (typeof run.id !== 'string' || typeof run.at !== 'string' || typeof run.ruleId !== 'string') return undefined
  if (!Array.isArray(run.actions) || typeof run.message !== 'object' || run.message === null) return undefined
  return run as Run
}

/** 读整份文件。 */
function parseFile(value: unknown): RunsFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as { version?: unknown; runs?: unknown }
  if (file.version !== 1 || !Array.isArray(file.runs)) return undefined
  return { version: 1, runs: file.runs.map(parseRun).filter((run): run is Run => run !== undefined) }
}

/**
 * 打开命中记录的仓。
 * @param options - `path` 是 `runs.json`；其余什么都不读环境，所以测试能指到临时目录。
 * @returns 仓。
 */
export function createRunStore(options: { readonly path: string }): RunStore {
  const write = serialWriter()
  let runs: Run[] = []

  /** 最新的在前，写盘一次。 */
  async function persist(): Promise<void> {
    await write(options.path, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`)
  }

  return {
    async load() {
      const file = await readJson(options.path, parseFile, { version: 1, runs: [] })
      // 最新的在前：文件里按追加顺序存，读回来时反过来，页面就不必每次排序。
      runs = [...file.runs].reverse()
    },
    list: () => [...runs],
    get: id => runs.find(run => run.id === id),
    async append(run) {
      const complete: Run = { ...run, id: run.id ?? `run-${randomUUID()}` }
      runs = [complete, ...runs]
      await persist()
      return complete
    },
    async patch(id, change) {
      const index = runs.findIndex(run => run.id === id)
      const current = runs[index]
      if (current === undefined) return undefined
      const updated: Run = {
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
