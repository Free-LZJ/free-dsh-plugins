// @vitest-environment jsdom
/**
 * The console contract, checked at the one boundary it exists for: who owns the
 * panel's seat.
 *
 * Adoption takes exactly one seat away — the sidebar row. The panel itself
 * (`main:<id>`) must survive in both modes, because the workbench opens a panel
 * by selecting that key; a contract that withdrew it would leave a home-list card
 * that opens nothing, and no other spec would notice.
 *
 * The other cases are the ones a real profile produces: a workbench composed
 * *after* the adopting plugin (the Loader's row order is the user's profile, not
 * this package's), a workbench that goes away when the user disables the row, and
 * no workbench at all.
 *
 * @module @free-lzj/dsh-console/tests/register
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { useConsolePanel, type ConsolePanelDescriptor, type StandalonePanelOptions } from '../src/client/register.ts'
import { bench, type ConsoleBench } from './support/bench.ts'

/** A component stand-in: the contract never renders, it only registers. */
const Panel = (): null => null
const Icon = (): null => null

/** What every adopting plugin passes. */
function fixtures(): { descriptor: ConsolePanelDescriptor; fallback: StandalonePanelOptions } {
  return {
    descriptor: {
      id: 'mail',
      title: () => '邮件',
      description: () => '读邮件',
      order: 20,
      render: Panel,
    },
    fallback: { locale: 'panel.mail', order: 40, label: () => '邮件', Icon },
  }
}

/**
 * Mount a plugin that adopts the contract.
 * @param suite - the bench.
 * @returns the fiber, so a spec can unload the adopter.
 */
async function mountAdopter(suite: ConsoleBench): Promise<Awaited<ReturnType<ConsoleBench['mount']>>> {
  const { descriptor, fallback } = fixtures()
  return suite.mount((ctx: Context) => {
    useConsolePanel(ctx, descriptor, fallback)
  })
}

describe('console contract', () => {
  it('keeps the classic panel when no workbench is composed', async () => {
    const suite = await bench()
    await mountAdopter(suite)
    expect(suite.mainKeys()).toEqual(['mail'])
    expect(suite.sidebarIds()).toEqual(['mail'])
  })

  it('takes only the sidebar row away from a workbench that is already there', async () => {
    const suite = await bench()
    const adopted: string[] = []
    await suite.composeWorkbench({
      register: (descriptor) => {
        adopted.push((descriptor as ConsolePanelDescriptor).id)
        return () => {}
      },
    })
    await mountAdopter(suite)
    expect(adopted).toEqual(['mail'])
    // The panel stays: the workbench opens it by selecting this exact key.
    expect(suite.mainKeys()).toEqual(['mail'])
    expect(suite.sidebarIds()).toEqual([])
  })

  it('hands the row over when the workbench is composed after it', async () => {
    const suite = await bench()
    await mountAdopter(suite)
    // The Loader mounted this plugin's row first.
    expect(suite.sidebarIds()).toEqual(['mail'])

    const adopted: string[] = []
    await suite.composeWorkbench({
      register: (descriptor) => {
        adopted.push((descriptor as ConsolePanelDescriptor).id)
        return () => {}
      },
    })
    expect(adopted).toEqual(['mail'])
    expect(suite.mainKeys()).toEqual(['mail'])
    expect(suite.sidebarIds()).toEqual([])
  })

  it('takes the row back when the workbench goes away', async () => {
    const suite = await bench()
    await mountAdopter(suite)
    const workbench = await suite.composeWorkbench({ register: () => () => {} })
    expect(suite.sidebarIds()).toEqual([])

    await workbench.dispose()
    expect(suite.mainKeys()).toEqual(['mail'])
    expect(suite.sidebarIds()).toEqual(['mail'])
  })

  it('withdraws every seat when the adopting plugin unloads', async () => {
    const suite = await bench()
    const fiber = await mountAdopter(suite)
    expect(suite.sidebarIds()).toEqual(['mail'])
    await fiber.dispose()
    expect(suite.mainKeys()).toEqual([])
    expect(suite.sidebarIds()).toEqual([])
  })

  it('leaves exactly one row behind whichever order the plugin and the workbench unload', async () => {
    const suite = await bench()
    const fiber = await mountAdopter(suite)
    const workbench = await suite.composeWorkbench({ register: () => () => {} })
    expect(suite.sidebarIds()).toEqual([])

    await workbench.dispose()
    await fiber.dispose()
    expect(suite.mainKeys()).toEqual([])
    expect(suite.sidebarIds()).toEqual([])
  })

  it('withdraws the panel once, however many times it is mounted and dropped', async () => {
    const suite = await bench()
    const fiber = await mountAdopter(suite)
    const workbench = await suite.composeWorkbench({ register: () => () => {} })
    await workbench.dispose()
    // The row came back exactly once, not once per handover.
    expect(suite.sidebarIds()).toEqual(['mail'])
    await fiber.dispose()
    expect(suite.sidebarIds()).toEqual([])
  })
})
