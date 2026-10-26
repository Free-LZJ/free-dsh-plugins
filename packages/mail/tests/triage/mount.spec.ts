/**
 * 装配层的验收：规则真的落盘、真的被读回、旧插件的数据真的会被搬过来。
 *
 * 逻辑层（`triage.spec.ts`）用假端口跑完整条链路；这一层补的是「邮件插件把一个
 * 引擎接起来」那几步——目录怎么算、默认规则从哪来、写操作落到哪个文件。它不碰
 * cordis 的真实生命周期，所以一个假 Context 就够。
 *
 * @module @free-lzj/dsh-mail/tests/triage/mount
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { createTriage, type TriageEngine } from '../../src/triage/mount.ts'
import { DEFAULT_CONFIG as TRIAGE_DEFAULT } from '../../src/triage/config.ts'
import type { MailLike, MailSummaryLike } from '../../src/triage/types.ts'

/** 发货的默认规则：这份文件必须真的能解析，否则新装的用户第一次就没有规则。 */
const DEFAULT_RULES = fileURLToPath(new URL('../../defaults/basic.yml', import.meta.url))

/** 一个什么都不提供的 Context：装配层只用到 `get`。 */
const quietContext = (): Context => ({ get: () => undefined }) as unknown as Context

/** 一个只回答「读不到正文」的邮件能力。 */
function mailStub(overrides: Partial<MailLike> = {}): MailLike {
  return {
    accounts: () => [],
    listMailboxes: async () => [],
    ensureFolder: async () => ({ ok: true, path: 'Archive' }),
    applyAction: async () => ({ ok: true }),
    fetchDetail: async () => undefined,
    ...overrides,
  }
}

/** 一个只用来观察日志的告警收集器。 */
function logger(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line: string) => { lines.push(line) } }
}

/**
 * 一个隔离的工作区。
 *
 * `home` 是邮件插件目录，旧插件的目录与它同级——每个测试各自一个根，否则
 * 「迁移」那一例会把自己的 `mailflow/` 留给同一次运行里后面的测试。
 * @param tag - 临时目录名里的标记，方便看失败的是哪一条。
 * @returns 邮件插件的数据目录。
 */
async function workspace(tag: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `mail-triage-${tag}-`))
  const home = join(root, 'mail')
  await mkdir(home, { recursive: true })
  return home
}

const engines: TriageEngine[] = []

/**
 * 建一个引擎并启动它。
 * @param home - 邮件插件的数据目录（`$DSH_HOME/mail`）。
 * @param mail - 邮件能力。
 * @returns 已启动的引擎与它记下的日志。
 */
async function mounted(home: string, mail: MailLike = mailStub()): Promise<{ engine: TriageEngine; lines: string[] }> {
  const seen = logger()
  const engine = createTriage(quietContext(), {
    home,
    defaultRules: DEFAULT_RULES,
    config: TRIAGE_DEFAULT,
    mail,
    log: seen.log,
    warn: seen.log,
  })
  engines.push(engine)
  await engine.start()
  return { engine, lines: seen.lines }
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
})

describe('分诊装配', () => {
  it('首次启动写下发货的默认规则，并说是从默认规则来的', async () => {
    const home = await workspace('mount')
    const { engine, lines } = await mounted(home)

    const view = await engine.routes.rules()
    expect(view.source).toBe('default')
    // 发货规则八条：四条确定性快路径（GitHub / Jira / 安全发件人 / 群发）+ 四条按类型判类。
    // 写歪了这里会先炸。
    expect(view.rules.map(rule => rule.id)).toEqual([
      'github', 'jira-bugfix', 'security', 'promo', 'ai-security', 'ai-todo', 'ai-dev', 'ai-newsletter',
    ])
    expect(view.path.endsWith(join('triage', 'rules.yml'))).toBe(true)
    expect(existsSync(view.path)).toBe(true)
    expect(lines.some(line => line.includes('已加载 8 条规则'))).toBe(true)

    // Jira 那条的意图必须钉在默认规则里：派单会话 + 通知，且派单会话不落在项目目录下。
    const jira = view.rules.find(rule => rule.id === 'jira-bugfix')
    expect(jira?.then.map(action => action.kind)).toEqual(['session', 'notify'])
    expect(jira?.then[0]?.workspacePath).toBe('D:/dsh-work')
    expect(jira?.then[0]?.instructions).toContain('open_session')

    // 再看一次：文件已经在，来源就该是 file。
    const second = await mounted(home)
    expect((await second.engine.routes.rules()).source).toBe('file')
  })

  it('开关一条规则落到规则文件里，并且立刻生效', async () => {
    const home = await workspace('toggle')
    const { engine } = await mounted(home)

    expect(await engine.routes.setEnabled('github', false)).toEqual({ ok: true })
    const view = await engine.routes.rules()
    expect(view.rules.find(rule => rule.id === 'github')?.enabled).toBe(false)
    // 注释要留住：用户读的是这个文件，agent 改的也是它。
    expect(await readFile(view.path, 'utf8')).toContain('# 发货默认规则')

    // 不存在的 id 要回一句人话，而不是静默成功。
    const missing = await engine.routes.setEnabled('nope', false)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('nope')
  })

  it('把旧插件留下的规则搬过来，只搬不删', async () => {
    const home = await workspace('legacy')
    const legacy = join(home, '..', 'mailflow')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'rules.yml'), [
      '- id: mine',
      '  name: 我自己的规则',
      '  when:',
      '    - kind: subject',
      '      any: [发票]',
      '  then:',
      '    - kind: markRead',
      '',
    ].join('\n'), 'utf8')

    const { engine } = await mounted(home)
    const view = await engine.routes.rules()
    expect(view.rules.map(rule => rule.id)).toEqual(['mine'])
    expect(view.source).toBe('file')
    // 旧目录还在：那是用户的文件，不是本插件的缓存。
    expect(existsSync(join(legacy, 'rules.yml'))).toBe(true)
  })

  it('试跑只回答会命中哪条，不改动任何邮件', async () => {
    const home = await workspace('try')
    const summary: MailSummaryLike = {
      accountId: 'qq', folder: 'INBOX', uid: 7, uidValidity: 1,
      subject: '发票到了', from: { address: 'billing@example.com' }, date: '2026-01-01T00:00:00.000Z',
      seen: false, flagged: false, hasAttachments: false, snippet: '', headers: {},
    }
    const applied: unknown[] = []
    const mail = mailStub({
      fetchDetail: async () => ({
        text: '正文', subject: summary.subject, from: summary.from, date: summary.date, snippet: '',
      }),
      applyAction: async (action) => { applied.push(action); return { ok: true } },
    })
    const engine = createTriage(quietContext(), {
      home,
      defaultRules: DEFAULT_RULES,
      config: TRIAGE_DEFAULT,
      mail,
      log: () => undefined,
      warn: () => undefined,
    })
    engines.push(engine)
    await engine.start()
    // 默认规则里没有「发票」，所以试跑必须说没命中。
    const outcome = await engine.routes.test('qq', 'INBOX', 7)
    expect(outcome).toMatchObject({ ruleId: '(none)' })
    expect(applied).toHaveLength(0)
  })

  it('读不到那封邮件时试跑说明原因', async () => {
    const home = await workspace('try-miss')
    const { engine } = await mounted(home)
    const outcome = await engine.routes.test('qq', 'INBOX', 7)
    expect(outcome).toMatchObject({ ok: false })
  })
})

/** 让未使用的 `summary` 在类型层面仍然是一份合法摘要。 */
void (undefined as unknown as MailSummaryLike)