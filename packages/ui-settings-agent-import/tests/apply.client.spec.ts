// @vitest-environment jsdom
/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// The three faces below ship as browser bundles the shell loads through its
// module table, so the imports are side effects and the exports come from it.
import '@deepseek-ai/dsh-client-locale/client'
import '@deepseek-ai/dsh-client-ui-renderer/client'
import '@deepseek-ai/dsh-client-ui-settings/client'
import { clientModule } from './support/module-loader.ts'
import { RemoteError, TestRemote } from './support/runtime.ts'
import { AgentImportCard } from '../src/client/AgentImportCard.tsx'
import { apply, inject, NS } from '../src/client/index.ts'
import type { AgentImportCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

const { LocaleRuntime } = clientModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')
type RendererClient = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry } = clientModule<RendererClient>('@deepseek-ai/dsh-client-ui-renderer')
/** The registry instance face this spec types its bench against. */
type SlotRegistry = InstanceType<RendererClient['SlotRegistry']>
const { apply: settingsApply, inject: settingsInject } = clientModule<typeof import('@deepseek-ai/dsh-client-ui-settings/client')>('@deepseek-ai/dsh-client-ui-settings')

/** The Plugins page entry this page occupies. */
const ITEM_ID = 'agent-import'

/** A serialized plain-object schema: the Host vouches for the row's section, not its members. */
const SCHEMA = { uid: 1, refs: { 1: { type: 'object' } } }

/** The section a served row carries. */
const SECTION = {
  sources: ['codex', 'claude-code'],
  projectRoot: '',
  codex: { home: '/home/u/.codex' },
  mcp: true,
  maxServers: 8,
}

/** One Host view of a served namespace. */
function view(ns: string, value: Record<string, unknown> = SECTION, revision = 0) {
  return { ns, schema: SCHEMA, value, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, describeSettings, remote }
}

/** The Plugins page's official-plugin slot, as its owner declares it. */
function declareOfficialItems(slots: SlotRegistry): void {
  slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('agent-import client apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('registers the settings card while the Host serves the namespace, and speaks its dictionary', async () => {
    const { ctx, slots, locale } = await bench(['agent-import'])
    declareOfficialItems(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.component).toBe(AgentImportCard)
    expect(entry.options).toMatchObject({ id: ITEM_ID, order: 50 })
    expect(resolveSlotLabel(entry.options.label)).toBe('代理配置导入')
    expect(entry.locale).toBe(NS)
    expect(locale.bind(NS)('save')).toBe('保存')

    const face = (entry.inject as () => Pick<AgentImportCardFace, 'hooks'>)()
    expect(Object.keys(face)).toEqual([
      'edit', 'clear', 'setToggle', 'setChoices', 'setList', 'save', 'discard', 'refreshReport', 'hooks',
    ])
    // The page reads the served section through the Host's own form, nested
    // option objects included, and publishes it as the state the card renders.
    expect(face.hooks.agentImportCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      sources: {
        choices: [{ value: 'codex', checked: true }, { value: 'claude-code', checked: true }],
        overridden: false,
      },
      serverDenyList: { rows: [''], overridden: false },
      values: {
        'codex.home': { text: '/home/u/.codex', overridden: false, invalid: false },
        maxServers: { text: '8', overridden: false, invalid: false },
      },
      switches: { mcp: { checked: true, overridden: false } },
    })
  })

  it('registers nothing while the Host does not serve the namespace', async () => {
    const { ctx, slots, describeSettings } = await bench(['shell'])
    declareOfficialItems(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('collapses the settings card on teardown', async () => {
    const { ctx, slots } = await bench(['agent-import'])
    declareOfficialItems(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
