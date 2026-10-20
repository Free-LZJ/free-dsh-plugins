// @vitest-environment jsdom
/**
 * The bench the contract's client half is driven on.
 *
 * A real cordis Context plus the shell's real slot registry. Standing in for the
 * registry would test a promise the real one does not make: that `slots.inject`
 * fires once a seat is declared, and that a withdrawn registration really leaves
 * the ledger.
 *
 * The registry is taken from the renderer's *browser* bundle — the object the
 * page actually composes — through the module table the shared test wiring
 * publishes. Its Node half exports no registry at all.
 *
 * @module @free-lzj/dsh-console/tests/support/bench
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
// Side effect: the bundle registers itself with the module table the shared
// test wiring (packages/agent-import/tests/support/module-loader.ts, this
// repository's vitest setupFile) installs in every spec.
import '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

/**
 * The module table the shared setup publishes.
 *
 * Declared here rather than imported: that file lives in another package's test
 * directory, which this package's `rootDir` does not cover, and a type-only
 * `import` of it would still pull the file into the program.
 */
declare global {
  // eslint-disable-next-line no-var -- a global the setup file assigns.
  var __DSH_TEST_MODULES__: { get(id: string): unknown } | undefined
}

/** The renderer's browser bundle, as the module table answered it. */
const renderer = globalThis.__DSH_TEST_MODULES__?.get('@deepseek-ai/dsh-client-ui-renderer') as
  | typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
  | undefined

/** What one bench hands a spec. */
export interface ConsoleBench {
  readonly ctx: Context
  readonly slots: SlotRegistry
  /** Panel keys currently occupying the layout's `main` seat. */
  mainKeys(): string[]
  /** Ids currently occupying the sidebar's global panel list. */
  sidebarIds(): string[]
  /**
   * Compose a workbench: provide the client service and keep its fiber.
   * @param service - the face an adopting plugin would register with.
   * @returns the fiber whose disposal is "the workbench went away".
   */
  composeWorkbench(service: { register(descriptor: never): () => void }): Promise<Fiber>
  /**
   * Mount one plugin over this bench, declaring the services it reads.
   * @param apply - the plugin body.
   * @param inject - services the body reads (a plugin reads only what it declares).
   * @returns the plugin's fiber.
   */
  mount(apply: (ctx: Context) => void, inject?: readonly string[]): Promise<Fiber>
}

/**
 * Build a bench: a root context, the real slot registry, and the two seats the
 * contract registers into (declared the way the shipped shell declares them).
 * @returns the bench.
 */
export async function bench(): Promise<ConsoleBench> {
  if (renderer === undefined) throw new Error('bench: the renderer bundle was not registered with the module table')
  const ctx = new Context()
  await ctx.plugin(renderer.SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return {
    ctx,
    slots,
    mainKeys: () => slots.entriesOfSlot('main').flatMap(
      (entry) => (entry.options.key === undefined ? [] : [entry.options.key]),
    ),
    sidebarIds: () => slots.entriesOfSlot('sidebar.panellist').flatMap((entry) => (
      (entry.options as { id?: string }).id === undefined ? [] : [(entry.options as { id: string }).id]
    )),
    composeWorkbench: async (service) => ctx.plugin((inner) => {
      inner.provide('console', service)
    }),
    // A plugin reads a service only after declaring it, so the mount declares
    // the same one an adopting plugin's own `inject` carries.
    mount: async (apply, inject = ['slots']) => ctx.plugin(Object.assign(apply, { inject: [...inject] })),
  }
}
