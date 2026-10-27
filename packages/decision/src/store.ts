/**
 * 落盘：原子写，与「读坏了怎么办」的统一答案。
 *
 * 三份状态（规则文件、命中记录、待撤销队列）都走这里，是为了让「临时文件 + rename」
 * 这个模式只有一份实现——它有两处容易写错的地方（Windows 上 rename 会被杀毒软件
 * 短暂占用、权限要在创建时带上而不是改名之后），复制三遍迟早会有一份漏掉。
 *
 * 读到坏 JSON 一律**回落成空**而不是抛：插件必须能起来，否则用户连设置页都打不开
 * 去修它。规则文件是例外——它是用户写的配置，坏了要报错给人看（见 `rules.ts`）。
 *
 * @module @free-lzj/dsh-decision/store
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Windows 上 rename 的临时失败码；这几个值得重试，其余立刻上抛。 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * 改名到位，只重试「关于时机」的失败。
 * @param from - 临时文件。
 * @param to - 它要替换的目标。
 */
export async function renameOnto(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code
      if (attempt >= 6 || typeof code !== 'string' || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 20))
    }
  }
}

/**
 * 原子写一份文本：先写旁边的临时文件再改名，读的人永远看不到半份。
 *
 * 权限设两次是刻意的：`mode` 只在创建临时文件时生效，而改名会把目标换成那个文件的
 * 权限，所以创建时带一次就够——这里带的是 `0o600`，因为这些文件里有邮件主题与发件人。
 * @param path - 目标路径。
 * @param text - 内容。
 */
export async function writeTextFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await renameOnto(temporary, path)
  // ponytail: 尽力而为，Windows 忽略它；插件目录才是真正的边界。
  await chmod(path, 0o600).catch(() => undefined)
}

/**
 * 读一份 JSON。缺失、坏 JSON、结构不对都回落成 `fallback`。
 * @param path - 目标路径。
 * @param parse - 把解析出来的 `unknown` 收成可信形状；返回 undefined 表示不可信。
 * @param fallback - 读不出来时用的值。
 * @returns 可信的值。
 */
export async function readJson<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
  fallback: T,
): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return fallback
  }
  try {
    const parsed = parse(JSON.parse(raw) as unknown)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 把一份状态串行地写出去。
 *
 * 面板的按钮与扫描循环可能同时在写，所以要一条链把它们排起来：否则两次写会按
 * 「谁先写完」而不是「谁先发生」决定最终内容。
 * @returns 一个 `write` 函数，调用方只管调它。
 */
export function serialWriter(): (path: string, text: string) => Promise<void> {
  let tail: Promise<unknown> = Promise.resolve()
  return (path, text) => {
    const run = tail.then(() => writeTextFile(path, text), () => writeTextFile(path, text))
    // 链必须活过一次失败的写，否则后面每一次都会被跳过。
    tail = run.catch(() => undefined)
    return run
  }
}
