/**
 * The registration helper every adopting plugin calls.
 *
 * A plugin contributes two seats, and the workbench only ever takes one of them
 * away:
 *
 * - **`main:<id>`** — the panel itself. Registered in *both* modes, because the
 *   workbench opens a panel by selecting exactly this key through
 *   `ctx.layout.selectPanel`. Withdrawing it would leave a card that opens
 *   nothing.
 * - **`sidebar.panellist` row** — the stand-alone way in. A workbench replaces
 *   it with a card on its own home list, so it is the one seat adoption drops.
 *
 * The mode is not decided once, at this plugin's own startup: the Loader may
 * mount the workbench's row *after* this one, and disabling the workbench in the
 * profile must hand the row back. So adoption is expressed as a **dependency**
 * (`ctx.inject`), which cordis runs when the service appears and unloads when it
 * goes away, while the stand-alone row covers every moment in between. That is
 * the whole reason this is a helper rather than a line at each call site.
 *
 * @module @free-lzj/dsh-console/client/register
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  CONSOLE_SERVICE,
  consoleService,
  type ConsoleClientService,
  type ConsolePanelDescriptor,
  type StandalonePanelOptions,
} from './contract.ts'

export type { ConsoleClientService, ConsolePanelDescriptor, StandalonePanelOptions }
export { CONSOLE_SERVICE, consoleService }

/**
 * Register a panel with the workbench when it is reachable, and keep a classic
 * sidebar row when it is not.
 *
 * Call it from the plugin's own `apply`, synchronously. Every registration rides
 * the caller's fiber (each is a `ctx.effect`, `ctx.slots.inject`, or
 * `ctx.inject`), so the plugin's unload removes whichever are live.
 *
 * The registration sites are typed `as never` on purpose: which dictionary
 * namespace a caller's `main` seat carries is decided by the *caller's* module
 * augmentation, which this package cannot see across packages. The call is the
 * contract; the shape is checked at the caller's own component, where it already
 * was.
 * @param ctx - the adopting plugin's browser context.
 * @param descriptor - what the workbench should list, and the panel to open.
 * @param fallback - the sidebar row used while no workbench answers.
 */
export function useConsolePanel(
  ctx: ClientContext,
  descriptor: ConsolePanelDescriptor,
  fallback: StandalonePanelOptions,
): void {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: descriptor.id, locale: fallback.locale,
  } as never, descriptor.render as never)), `${descriptor.id}: panel`)

  let row: (() => void) | undefined
  const mountRow = (): void => {
    if (row !== undefined) return
    row = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: descriptor.id,
      order: fallback.order ?? 40,
      locale: fallback.locale,
      label: fallback.label,
    } as never, fallback.Icon as never))
  }

  mountRow()

  ctx.inject([CONSOLE_SERVICE], (inner) => {
    row?.()
    row = undefined
    const client = consoleService(inner) as ConsoleClientService
    inner.effect(() => client.register(descriptor), `${descriptor.id}: console panel`)
    // The workbench unloaded (or was disabled): hand the row back.
    return () => {
      mountRow()
    }
  })
}
