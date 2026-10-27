/**
 * The persisted board document, and the one thing it must never lose: **a card's
 * history**.
 *
 * Cards written before the audit trail became codes carry finished sentences. The
 * reader keeps them (as `legacy` lines) instead of dropping them — a card whose
 * "why" vanished is a card nobody can audit.
 *
 * @module @free-dsh-plugins/dsh-console/tests/workbench/store
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyDocument, readWorkbench } from '../../src/workbench/store.ts'

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 5 })
})

/** A fresh home directory with an optional board document already written. */
async function homeWith(document?: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-console-store-'))
  homes.push(home)
  if (document !== undefined) {
    await mkdir(join(home, 'dsh-console'), { recursive: true })
    await writeFile(join(home, 'dsh-console', 'workbench.json'), JSON.stringify(document), 'utf8')
  }
  return home
}

/** A card shaped like an older build wrote it: reasons are plain sentences. */
function legacyCard(): Record<string, unknown> {
  return {
    id: 'card-1',
    source: 'mail',
    dedupeKey: 'mail:card-1',
    title: '页面报错',
    column: 'todo',
    status: 'idle',
    priority: 'normal',
    kind: 'bug',
    confidence: 0.6,
    awaitingConfirmation: false,
    createdAt: 1,
    updatedAt: 1,
    decision: {
      action: 'hold',
      routeId: 'low-confidence',
      ruleVersion: 'workbench-routes-v1',
      reasons: ['关键词「报错」命中 bug 类'],
      classification: {
        kind: 'bug',
        priority: 'normal',
        confidence: 0.6,
        reasons: ['命中 bug 关键词 1 个'],
      },
    },
  }
}

describe('readWorkbench', () => {
  it('answers an empty document when there is no file', async () => {
    expect(await readWorkbench(await homeWith())).toEqual(emptyDocument())
  })

  it('answers an empty document when the file is broken', async () => {
    const home = await homeWith()
    await mkdir(join(home, 'dsh-console'), { recursive: true })
    await writeFile(join(home, 'dsh-console', 'workbench.json'), '{ not json', 'utf8')
    expect(await readWorkbench(home)).toEqual(emptyDocument())
  })

  it('keeps the sentences an older build stored, as legacy lines', async () => {
    const document = { version: 1, cards: [legacyCard()], sessions: [] }
    const loaded = await readWorkbench(await homeWith(document))
    const decision = loaded.cards[0]?.decision
    expect(decision?.reasons).toEqual([{ code: 'legacy', text: '关键词「报错」命中 bug 类' }])
    expect(decision?.classification.reasons).toEqual([{ code: 'legacy', text: '命中 bug 关键词 1 个' }])
  })

  it('leaves structured reasons alone', async () => {
    const card = legacyCard()
    const decision = card['decision'] as Record<string, unknown>
    decision['reasons'] = [{ code: 'route-none' }]
    const loaded = await readWorkbench(await homeWith({ version: 1, cards: [card], sessions: [] }))
    expect(loaded.cards[0]?.decision.reasons).toEqual([{ code: 'route-none' }])
  })

  it('drops entries without an id rather than failing the whole board', async () => {
    const loaded = await readWorkbench(await homeWith({ version: 1, cards: [{ title: 'x' }], sessions: [{ x: 1 }] }))
    expect(loaded.cards).toEqual([])
    expect(loaded.sessions).toEqual([])
  })
})
