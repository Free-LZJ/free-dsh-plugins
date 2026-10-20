/**
 * The workbench contract an adopting plugin imports:
 * `@free-lzj/dsh-console/contract`.
 *
 * A second plugin's browser bundle inlines this module, so it reaches for
 * nothing outside itself. Everything here is a type, a string constant, or a
 * function whose whole implementation arrives with the import.
 *
 * @module @free-lzj/dsh-console/contract
 */

export { CONSOLE_SERVICE, consoleService } from './contract.ts'
export type {
  ConsoleClientService,
  ConsolePanelDescriptor,
  SlotComponent,
  StandalonePanelOptions,
} from './contract.ts'
export { useConsolePanel } from './register.ts'
