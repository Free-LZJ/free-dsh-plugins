// @vitest-environment jsdom
/**
 * What the browser half registers, and that it leaves with the fiber.
 *
 * The source specs cannot catch this: `slots.inject` waits silently for a
 * declaration that never arrives, so a wrong slot key, a missing locale
 * namespace, or a dropped `inject` list makes the control vanish from a real
 * deployment while every unit test stays green. This spec drives the plugin
 * against a real slot registry and a real locale runtime and asserts the entries
 * the shell would render.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
// The faces below ship as browser bundles the shell loads through its module
// table, so the imports are side effects and the exports come from it.
import '@deepseek-ai/dsh-client-locale/client'
import '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import type { WorktreeActionInjected, WorktreesPanelInjected } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { WorktreeAction } from '../src/client/WorktreeAction.tsx'
import { WorktreesPanel } from '../src/client/WorktreesPanel.tsx'

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

/** What the stand-in services recorded. */
interface Recorded {
  /** Paths passed to the Workspace controller. */
  readonly registered: string[]
  /** Workspace ids passed to Workspace navigation. */
  readonly opened: string[]
  /** Workspace ids passed to the controller's delete. */
  readonly removed: string[]
  /** Panel keys passed to the layout service. */
  readonly panels: string[]
}

/**
 * Mount the registry, the dictionaries and stand-in services.
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
  const recorded: Recorded = { registered: [], opened: [], removed: [], panels: [] }
  ctx.provide('workspaces', {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        items: [{
          workspaceId: 'ws-tree',
          path: 'D:\\repo\\.agents\\worktrees\\one',
          title: 'one',
          sessionIds: [],
          createdAt: '',
          updatedAt: '',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      }),
      subscribe: () => () => {},
    },
    create: async ({ path }: { path: string }) => {
      recorded.registered.push(path)
      return { workspaceId: 'ws-worktree', path, title: path, sessionIds: [], createdAt: '', updatedAt: '' }
    },
    delete: async (workspaceId: string) => {
      recorded.removed.push(workspaceId)
    },
  })
  ctx.provide('uiWorkspace', {
    openWorkspace: async (workspaceId: string) => {
      recorded.opened.push(workspaceId)
    },
  })
  ctx.provide('layout', {
    selectPanel: (id: string) => {
      recorded.panels.push(id)
    },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, recorded }
}

/** The seats this plugin occupies. */
const HERO_ROW = 'conversation.hero.options'
const HEADER_ACTIONS = 'conversation.session.header.actions'
const PANEL = 'main'
const PANEL_ROW = 'sidebar.panellist'

/**
 * Declare every holder of the slots this plugin occupies.
 * @param slots - the registry to declare them on.
 */
function declareSeats(slots: SlotRegistry): void {
  slots.register({
    name: 'root',
    children: {
      'conversation.hero.options': { kind: 'list', scope: 'session' },
      'conversation.session.header': { kind: 'single', scope: 'session' },
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  // A child slot declaration belongs to its own holder, exactly as the shipped
  // Conversation shell declares it one level down.
  slots.register({
    name: 'conversation.session.header',
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
}

describe('worktree client apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'workspaces', 'uiWorkspace', 'layout'])
  })

  it('occupies the New Session row and the Session header with the create control', async () => {
    const { ctx, slots, locale } = await bench()
    declareSeats(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => {
      expect(slots.entries(HERO_ROW)).toHaveLength(1)
      expect(slots.entries(HEADER_ACTIONS)).toHaveLength(1)
    })
    for (const seat of [HERO_ROW, HEADER_ACTIONS] as const) {
      const entry = slots.entries(seat)[0]!
      expect(entry.component).toBe(WorktreeAction)
      expect(entry.options).toMatchObject({ id: 'worktree', order: 100 })
      expect(entry.locale).toBe(NS)
      expect(entry.options.label).toBeUndefined()
    }
    expect(locale.bind(NS)('trigger')).toBe('工作树')
  })

  it('occupies the main panel and its sidebar row', async () => {
    const { ctx, slots } = await bench()
    declareSeats(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => {
      expect(slots.entries(PANEL)).toHaveLength(1)
      expect(slots.entries(PANEL_ROW)).toHaveLength(1)
    })
    expect(slots.entries(PANEL)[0]!.component).toBe(WorktreesPanel)
    expect(slots.entries(PANEL_ROW)[0]!.options).toMatchObject({ id: 'worktrees', order: 45 })
  })

  it('registers a checkout, opens it, and switches to the manager on request', async () => {
    const { ctx, slots, recorded } = await bench()
    declareSeats(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries(HERO_ROW)).toHaveLength(1) })

    const face = (slots.entries(HERO_ROW)[0]!.inject as unknown as () => WorktreeActionInjected)()
    const workspaceId = await face.registerWorkspace('D:/repo/.agents/worktrees/one')
    await face.openWorkspace(workspaceId)
    face.openManager()

    expect(recorded.registered).toEqual(['D:/repo/.agents/worktrees/one'])
    expect(recorded.opened).toEqual(['ws-worktree'])
    expect(recorded.panels).toEqual(['worktrees'])
  })

  it('drops the registration naming a removed checkout', async () => {
    const { ctx, slots, recorded } = await bench()
    declareSeats(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries(PANEL)).toHaveLength(1) })

    const face = (slots.entries(PANEL)[0]!.inject as unknown as () => WorktreesPanelInjected)()
    await face.forgetWorkspace('D:\\repo\\.agents\\worktrees\\one')

    expect(recorded.removed).toEqual(['ws-tree'])
  })

  it('collapses every entry on teardown', async () => {
    const { ctx, slots } = await bench()
    declareSeats(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => {
      expect(slots.entries(HERO_ROW)).toHaveLength(1)
      expect(slots.entries(HEADER_ACTIONS)).toHaveLength(1)
      expect(slots.entries(PANEL)).toHaveLength(1)
      expect(slots.entries(PANEL_ROW)).toHaveLength(1)
    })

    await fiber.dispose()

    for (const seat of [HERO_ROW, HEADER_ACTIONS, PANEL, PANEL_ROW] as const) {
      expect(slots.entries(seat)).toHaveLength(0)
    }
  })
})
