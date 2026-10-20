/**
 * The console contract: the names, the descriptor, and the client service.
 *
 * Imported by the workbench *and* by every adopting plugin's client half. It has
 * **no runtime import of anything**: a second plugin's browser bundle inlines
 * this module, and only the shell's own platform modules are seeded into the
 * page's module table — a contract that reached for another bundle would need
 * the shell to know about it, which it does not.
 *
 * @module @free-lzj/dsh-console/contract
 */

// Type-only: the slot contracts both modes register against, and the Context
// merges that carry `ctx.slots` / `ctx.locale`.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime, SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType, ReactNode } from 'react'

/**
 * Name of the client service the workbench shell provides.
 *
 * An implementation detail of this contract: an adopting plugin calls
 * {@link ./register useConsolePanel} and never names the service itself. That
 * matters beyond taste — this package's Host half also augments `ctx.console`
 * (with the notification hub), and one interface cannot carry two types.
 */
export const CONSOLE_SERVICE = 'console'

/**
 * What the workbench offers an adopting plugin on the browser side.
 *
 * Deliberately about *the panel* only: a notice travels through the Host
 * service (`ctx.console.notify`), which still reaches the user when no page is
 * showing this panel.
 */
export interface ConsoleClientService {
  /**
   * Register one panel with the workbench.
   * @param descriptor - what the panel is and how to render it.
   * @returns the disposer the caller wraps in its own effect lifetime.
   */
  register(descriptor: ConsolePanelDescriptor): () => void
}

/** What an adopting plugin declares about its panel. */
export interface ConsolePanelDescriptor {
  /** Panel id: the `main` key the panel occupies, and the workbench's row key. */
  readonly id: string
  /** Localized title, resolved through the caller's own `t`. */
  readonly title: () => string
  /** Localized one-line description. */
  readonly description?: () => string
  /** Localized search terms beyond the title. */
  readonly keywords?: () => readonly string[]
  /** Ascending position in the home list; ties fall back to the title. */
  readonly order?: number
  /**
   * The panel's component, registered into `main` under this descriptor's id.
   *
   * The workbench opens a panel by selecting that key with `ctx.layout`, so this
   * component keeps the same props seat it would have had as a plain sidebar
   * panel — the layout renders it, not the workbench.
   */
  readonly render: SlotComponent<'main'>
  /** Glyph rendered on the home card; the workbench falls back to a letter. */
  readonly icon?: ReactNode
}

/**
 * The stand-alone sidebar row a plugin keeps while no workbench answers.
 *
 * The panel id and the component come from the descriptor: there is one panel,
 * and only its *way in* differs between the two modes.
 */
export interface StandalonePanelOptions {
  /** Dictionary namespace the row's label translates in. */
  readonly locale: string
  /** Sidebar row order. */
  readonly order?: number
  /** Localized sidebar label. */
  readonly label: () => string
  /** Sidebar glyph. */
  readonly Icon: ComponentType<PropsRuntime<'sidebar.panellist'>>
}

/**
 * Read the workbench service without depending on it.
 * @param ctx - any browser context.
 * @returns the service, or undefined when this composition has no workbench.
 */
export function consoleService(ctx: ClientContext): ConsoleClientService | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(CONSOLE_SERVICE) as ConsoleClientService | undefined
}

/** Re-exported so an adopting plugin can type its own component the same way. */
export type { SlotComponent }
