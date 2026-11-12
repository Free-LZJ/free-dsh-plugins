/**
 * 端到端：一封邮件 → 一个任务 → 一条节点链。
 *
 * 这里用的是**真的**引擎、真的邮件连接器、真的规则文件，只有宿主能力（IMAP、会话）
 * 是假的。它要证明的是分层本身：邮件连接器只发事件，规则由引擎跑，会话动作由
 * 「另一个连接器」提供——三者之间没有互相 import 的领域知识。
 *
 * @module @free-lzj/dsh-mail/tests/pipeline
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskEngine, defineAction } from '@free-lzj/dsh-decision'
import type { ActionSpecLike, TaskConnector } from '@free-lzj/dsh-decision'
import { createMailConnector, MAIL_EVENT, type MailEventPayload, type MailOpsLike } from '../src/connector.ts'
import { DEFAULT_CONFIG } from '../src/triage/config.ts'

// 撤销窗口 0：这一组要看的是「链长什么样」，不是「排队 120 秒」。
const baseConfig = { ...DEFAULT_CONFIG, model: '', undoWindowSeconds: 0 }

/** 一个记账的邮件服务。 */
function mailOps(calls: string[]): MailOpsLike {
  return {
    async fetchDetail(_accountId, _folder, _uid) {
      return { subject: 'Run failed: E2E', from: { address: 'notifications@github.com' }, date: '2026-11-10T00:00:00Z', text: '工作流失败' }
    },
    async listMailboxes() {
      return [{ path: 'Archive', specialUse: '\\Archive' }]
    },
    async ensureFolder(_accountId, path) {
      return { ok: true, path }
    },
    async applyAction(action) {
      calls.push(JSON.stringify(action))
      return { ok: true, applied: 1 }
    },
  }
}

/** 「另一个连接器」：只提供一个建会话的动作，证明动作可以跨连接器。 */
function sessionConnector(calls: string[]): TaskConnector {
  return {
    id: 'dsh',
    label: 'DSH 宿主能力',
    directions: ['out'],
    implemented: true,
    triggers: [],
    actions: [
      defineAction({
        kind: 'session',
        sideEffect: true,
        async run(spec: ActionSpecLike) {
          const workspace = (spec as { readonly workspace?: string }).workspace ?? ''
          calls.push(`session:${workspace}`)
          return {
            ok: true,
            detail: `已在「${workspace}」新建会话`,
            sessionId: 'session-e2e',
            data: { scope: 'workspace', mode: 'create', workspace },
          }
        },
      }) as never,
    ],
    ports: {
      prompt: { render: async () => '交给 agent 的正文' },
    },
    vocabulary: {
      normalizeCondition: () => undefined,
      normalizeAction: input => {
        if (typeof input !== 'object' || input === null) return undefined
        const record = input as Record<string, unknown>
        if (record['kind'] !== 'session') return undefined
        return { kind: 'session', ...(typeof record['workspace'] === 'string' ? { workspace: record['workspace'] } : {}) } as ActionSpecLike
      },
    },
    defaultRules: '',
  }
}

/** 造一个事件载荷。 */
function payload(): MailEventPayload {
  return {
    accountId: 'qq',
    accountName: '工作邮箱',
    folder: 'INBOX',
    uid: 229676,
    uidValidity: 3,
    from: { address: 'notifications@github.com', name: 'GitHub' },
    subject: 'Run failed: E2E',
    date: '2026-11-10T00:00:00Z',
    headers: { 'list-id': 'free-lzj/free-dsh-plugins <free-dsh-plugins.github.com>' },
    snippet: '工作流失败',
    seen: false,
    flagged: false,
    hasAttachments: false,
  }
}

describe('一封邮件走完整条链', () => {
  it('事件 → 任务 → 规则 → 邮件动作 + 会话节点', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pipeline-'))
    const calls: string[] = []
    writeFileSync(join(home, 'rules.yml'), [
      'version: 1',
      'connector: mail',
      'rules:',
      '  - name: GitHub 工单',
      '    priority: 10',
      '    when:',
      '      - kind: from',
      '        any:',
      '          - notifications@github.com',
      '    then:',
      '      - kind: markRead',
      '      - kind: session',
      '        workspace: D:/open/free-dsh-plugins',
    ].join('\n') + '\n')

    const engine = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
    engine.register(createMailConnector({
      mail: mailOps(calls),
      config: () => baseConfig,
      log: () => undefined,
      warn: () => undefined,
    }))
    engine.register(sessionConnector(calls))
    await engine.start()

    const ack = await engine.emit({
      type: MAIL_EVENT,
      source: 'mail',
      dedupeKey: 'mail:qq:INBOX:229676',
      payload: payload(),
    })
    expect(ack).toMatchObject({ handled: true, triggerId: 'mail:new' })
    await engine.flush()

    const task = engine.view().tasks[0]
    expect(task).toBeDefined()
    expect(task?.title).toBe('Run failed: E2E')
    expect(task?.status).toBe('done')
    // 链：触发 → 规则 → 标已读 → 会话 → 会话节点。
    expect(task?.nodes.map(node => `${node.kind}:${node.sessionId ?? ''}`))
      .toEqual(['trigger:', 'rule:', 'markRead:', 'session:session-e2e', 'session:session-e2e'])
    // 邮件动作真的被调了，而且用的是这封信的坐标。
    expect(calls.some(call => call.includes('"op":"markRead"'))).toBe(true)
    expect(calls).toContain('session:D:/open/free-dsh-plugins')
    engine.stop()
  })

  it('同一封信重复到达只有一条任务', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pipeline-'))
    writeFileSync(join(home, 'rules.yml'), [
      'version: 1',
      'rules:',
      '  - name: 全部标已读',
      '    when: []',
      '    then:',
      '      - kind: markRead',
    ].join('\n') + '\n')
    const engine = new TaskEngine({ home, config: () => baseConfig, dueIntervalMs: 60_000 })
    engine.register(createMailConnector({
      mail: mailOps([]),
      config: () => baseConfig,
      log: () => undefined,
      warn: () => undefined,
    }))
    await engine.start()
    const event = { type: MAIL_EVENT, source: 'mail', dedupeKey: 'mail:qq:INBOX:1', payload: payload() }
    await engine.emit(event)
    await engine.flush()
    await engine.emit(event)
    expect(engine.view().tasks).toHaveLength(1)
    engine.stop()
  })
})
