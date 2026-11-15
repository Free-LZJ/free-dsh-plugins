/**
 * 任务引擎端到端：一个邮件事件 → 触发器 → 判定 → **BPMN 执行器** → 动作。
 *
 * 前面的测试分开守：`pipeline.spec.ts` 只验「规则 → 流程」的编译与路由，`task.spec.ts`
 * 用假连接器验核心。这里把真连接器、真规则、真引擎接起来，走一遍完整的一条链，看
 * 落地到任务上的节点是不是「触发 → 命中规则 → 动作」那个顺序。
 *
 * 全部在 `dryRun` 下跑：动作只记录不执行，所以不会碰任何真实邮箱。
 *
 * @module @free-lzj/dsh-mail/tests/triage/engine
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine } from '@free-lzj/dsh-decision'
import { createMailConnector, MAIL_EVENT, type MailOpsLike } from '../../src/connector.ts'
import { DEFAULT_CONFIG } from '../../src/triage/config.ts'
import type { Config } from '../../src/triage/types.ts'

const RULES = `# 端到端用的规则：两条，一条按头部命中、一条按发件人命中。
- id: github
  name: GitHub 通知
  connector: mail
  priority: 10
  when:
    - kind: from
      any:
        - notifications@github.com
  then:
    - kind: markRead

- id: promo
  name: 带退订头的群发
  connector: mail
  priority: 20
  when:
    - kind: header
      name: list-unsubscribe
  then:
    - kind: markRead
    - kind: move
      folder: '推广'
`

/** 不碰邮箱的 ops：端到端只走 dryRun，动作不会落地。 */
const ops: MailOpsLike = {
  fetchDetail: async () => undefined,
  listMailboxes: async () => [{ path: 'INBOX' }],
  ensureFolder: async (_accountId, path) => ({ ok: true, path }),
  applyAction: async () => ({ ok: true }),
}

/**
 * 起一台引擎，装真连接器，跑一封邮件。
 * @param mail - 事件载荷。
 * @returns 跑完后的任务。
 */
async function runOne(mail: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mail-engine-'))
  writeFileSync(join(home, 'rules.yml'), RULES, 'utf8')
  const config: Config = { ...DEFAULT_CONFIG, dryRun: true, repoRoot: 'D:/tmp' }
  const engine = new TaskEngine({
    home,
    config: () => ({
      enabled: config.enabled,
      dryRun: config.dryRun,
      undoWindowSeconds: config.undoWindowSeconds,
      runHistoryLimit: config.runHistoryLimit,
      runRetentionDays: config.runRetentionDays,
    }),
  })
  engine.register(createMailConnector({
    mail: ops,
    config: () => config,
    log: () => {},
    warn: () => {},
  }))
  await engine.start()
  await engine.emit({ type: MAIL_EVENT, source: 'mail', payload: mail } as never)
  await engine.flush()
  const task = engine.view().tasks[0]
  engine.stop()
  return task
}

describe('一个邮件事件走完整条链', () => {
  it('命中 GitHub 规则：触发、规则、动作三格都在', async () => {
    const task = await runOne({
      accountId: 'acc',
      folder: 'INBOX',
      uid: 11,
      uidValidity: 1,
      subject: 'CI failed',
      from: { address: 'notifications@github.com' },
      date: '2026-11-13T00:00:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      snippet: 'workflow failed',
      headers: {},
    })
    expect(task).toBeDefined()
    const kinds = task?.nodes.map(node => node.kind)
    expect(kinds?.[0]).toBe('trigger')
    expect(kinds).toContain('rule')
    expect(kinds).toContain('markRead')
    // 规则节点的说明是规则名，不是规则 id。
    expect(task?.nodes.find(node => node.kind === 'rule')?.detail).toBe('GitHub 通知')
    // dryRun 下动作只记录。
    expect(task?.nodes.find(node => node.kind === 'markRead')?.detail).toContain('试运行')
    expect(task?.status).toBe('done')
  })

  it('命中降价规则：两条动作按 then 的顺序落地', async () => {
    const task = await runOne({
      accountId: 'acc',
      folder: 'INBOX',
      uid: 12,
      uidValidity: 1,
      subject: '本周促销',
      from: { address: 'news@shop.example' },
      date: '2026-11-13T00:00:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      snippet: 'sale',
      headers: { 'list-unsubscribe': '<mailto:u@example>' },
    })
    const actions = task?.nodes.filter(node => node.kind === 'markRead' || node.kind === 'move').map(node => node.kind)
    expect(actions).toEqual(['markRead', 'move'])
    expect(task?.nodes.find(node => node.kind === 'rule')?.detail).toBe('带退订头的群发')
  })

  it('都不命中时任务记 skipped，且没有动作节点', async () => {
    const task = await runOne({
      accountId: 'acc',
      folder: 'INBOX',
      uid: 13,
      uidValidity: 1,
      subject: '在吗',
      from: { address: 'friend@example.com' },
      date: '2026-11-13T00:00:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      snippet: 'hi',
      headers: {},
    })
    expect(task?.status).toBe('skipped')
    expect(task?.nodes.filter(node => node.kind === 'markRead' || node.kind === 'move')).toEqual([])
  })
})
