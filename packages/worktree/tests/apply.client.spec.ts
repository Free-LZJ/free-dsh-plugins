// @vitest-environment jsdom
/**
 * What the browser half registers, and that it leaves with the fiber.
 *
 * The source specs cannot catch this: `slots.inject` waits silently for a
 * declaration that never arrives, so a wrong slot key, a missing locale
 * namespace, or a dropped `inject` list makes the control vanish from a real
 * deployment while every unit test stays green. This spec drives the plugin
 * against a real slot registry and a real locale runtime and asserts the entry
 * the shell would render.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
// The three faces below ship as browser bundles the shell loads through its
// module table, so the imports are side effects and the exports come from it.
import '@deepseek-ai/dsh-client-locale/client'
import '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import type { WorktreeActionInjected } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { WorktreeAction } from '../src/client/WorktreeAction.tsx'

/** The module table the shared vitest setup installs for browser bundles. */
interface TestModuleTable {
  get(id: string): unknown
}

/**
 * @param id - module id a browser bundle registered.
 * @returns its exports.
 */
function clientModule<T>(id: string): T {
  const table = (globalThis as unknown as { __DSH_TEST_MODULES__?: TestModuleTable }).__DSH_TEST_MODULES__
  const found = table?.get(id)
  if (found === undefined) throw new Error(`module table has no ${id}`)
  return found as T
}

const renderer = clientModule<typeof import('@deepseek-ai/dsh-client-ui-renderer/client')>('@deepseek-ai/dsh-client-ui-renderer')
const localeModule = clientModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')

/** The slot registry instance face this spec types its bench against. */
type SlotRegistry = InstanceType<typeof renderer.SlotRegistry>

/** What the stand-in Workspace services recorded. */
interface Recorded {
  /** Paths passed to the Workspace controller. */
  readonly registered: string[]
  /** Workspace ids passed to Workspace navigation. */
  readonly opened: string[]
}

/**
 * Mount the registry, the dictionaries and stand-in Workspace services.
 * @returns the context, the registry, the locale runtime and what was recorded.
 */
async function bench(): Promise<{
  ctx: Context
  slots: SlotRegistry
  locale: InstanceType<typeof localeModule.LocaleRuntime>
  recorded: Recorded
}> {
  const ctx = new Context()
  await ctx.plugin(renderer.SlotRegistry).await()
  const locale = new localeModule.LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const recorded: Recorded = { registered: [], opened: [] }
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ phase: 'ready', items: [], archivedSessionIds: [], pinnedSessionIds: [] }), subscribe: () => () => {} },
    create: async ({ path }: { path: string }) => {
      recorded.registered.push(path)
      return { workspaceId: 'ws-worktree', path, title: path, sessionIds: [], createdAt: '', updatedAt: '' }
    },
  })
  ctx.provide('uiWorkspace', {
    openWorkspace: async (workspaceId: string) => {
      recorded.opened.push(workspaceId)
    },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, recorded }
}

/**
 * Declare the Conversation content factory's Hero row, the only holder of the
 * option slot this plugin occupies.
 * @param slots - the registry to declare it on.
 */
function declareHeroRow(slots: SlotRegistry): void {
  slots.register({
    name: 'root',
    children: { 'conversation.hero.options': { kind: 'list', scope: 'session' } },
  } as never, () => null)
}

describe('worktree client apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'workspaces', 'uiWorkspace'])
  })

  it('occupies the New Session row with one ordered, localized entry', async () => {
    const { ctx, slots, locale } = await bench()
    declareHeroRow(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('conversation.hero.options')).toHaveLength(1) })
    const entry = slots.entries('conversation.hero.options')[0]!
    expect(entry.component).toBe(WorktreeAction)
    expect(entry.options).toMatchObject({ id: 'worktree', order: 100 })
    expect(entry.locale).toBe(NS)
    expect(locale.bind(NS)('trigger')).toBe('新建工作树会话')
    // The control renders its own text inside the button, so the registration
    // carries no projected label for the shell to draw.
    expect(entry.options.label).toBeUndefined()
  })

  it('registers the checkout and opens it through the harness services', async () => {
    const { ctx, slots, recorded } = await bench()
    declareHeroRow(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('conversation.hero.options')).toHaveLength(1) })
    const entry = slots.entries('conversation.hero.options')[0]!

    const face = (entry.inject as unknown as () => WorktreeActionInjected)()
    const workspaceId = await face.registerWorkspace('D:/repo/.agents/worktrees/one')
    await face.openWorkspace(workspaceId)

    expect(recorded.registered).toEqual(['D:/repo/.agents/worktrees/one'])
    expect(recorded.opened).toEqual(['ws-worktree'])
  })

  it('collapses the entry on teardown', async () => {
    const { ctx, slots } = await bench()
    declareHeroRow(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('conversation.hero.options')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('conversation.hero.options')).toHaveLength(0)
  })
})
