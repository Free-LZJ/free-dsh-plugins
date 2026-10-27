/**
 * 落盘这一层的行为：原子写读到的永远是完整内容，坏文件回落成空。
 *
 * 这些断言值钱的地方在于它们**在失败时能复现**：临时文件 + rename 写错会让读到
 * 半份 JSON，而那在真实使用里表现为「规则突然全没了」。
 *
 * @module @free-lzj/dsh-decision/tests/store
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJson, serialWriter, writeTextFile } from '../src/store.ts'

const paths: string[] = []

/** 一个临时目录，测试结束删掉。 */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-decision-store-'))
  paths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('writeTextFile', () => {
  it('creates the directory it needs and leaves no temporary file behind', async () => {
    const home = await scratch()
    const path = join(home, 'nested', 'deeper', 'runs.json')
    await writeTextFile(path, '{"a":1}\n')
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n')
    // 临时文件不能留在盘上：它是实现细节，谁看见都会以为有半份数据。
    expect(await readdir(join(home, 'nested', 'deeper'))).toEqual(['runs.json'])
  })

  it('replaces an existing file whole', async () => {
    const home = await scratch()
    const path = join(home, 'state.json')
    await writeTextFile(path, 'first-and-longer')
    await writeTextFile(path, 'second')
    expect(await readFile(path, 'utf8')).toBe('second')
  })
})

describe('readJson', () => {
  const parse = (value: unknown): { a: number } | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { a?: unknown }
    return typeof record.a === 'number' ? { a: record.a } : undefined
  }

  it('answers the fallback when the file is missing', async () => {
    const home = await scratch()
    expect(await readJson(join(home, 'nope.json'), parse, { a: 0 })).toEqual({ a: 0 })
  })

  it('answers the fallback when the file is broken JSON', async () => {
    const home = await scratch()
    const path = join(home, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    expect(await readJson(path, parse, { a: 0 })).toEqual({ a: 0 })
  })

  it('answers the fallback when the shape is not what the parser accepts', async () => {
    const home = await scratch()
    const path = join(home, 'odd.json')
    await writeFile(path, '{"b":1}', 'utf8')
    expect(await readJson(path, parse, { a: 0 })).toEqual({ a: 0 })
  })

  it('answers the parsed value when it is trustworthy', async () => {
    const home = await scratch()
    const path = join(home, 'good.json')
    await writeFile(path, '{"a":7}', 'utf8')
    expect(await readJson(path, parse, { a: 0 })).toEqual({ a: 7 })
  })
})

describe('serialWriter', () => {
  it('writes in call order even when the caller does not await', async () => {
    const home = await scratch()
    const path = join(home, 'ordered.json')
    const write = serialWriter()
    // 不 await：这正是「按钮 + 扫描循环同时写」的形状。
    const first = write(path, 'one')
    const second = write(path, 'two')
    const third = write(path, 'three')
    await Promise.all([first, second, third])
    expect(await readFile(path, 'utf8')).toBe('three')
  })

  it('keeps writing after one write fails', async () => {
    const home = await scratch()
    const path = join(home, 'recovered.json')
    const write = serialWriter()
    // 一个非法的目标路径（父级是文件）让这一次失败；链不能因此断掉。
    const blocker = join(home, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    await expect(write(join(blocker, 'child.json'), 'lost')).rejects.toThrow()
    await write(path, 'after')
    expect(await readFile(path, 'utf8')).toBe('after')
  })
})
