// @vitest-environment jsdom
/**
 * The package's faces, checked at the boundary the harness actually crosses.
 *
 * Four mistakes here have no other coverage — each leaves the source specs green
 * while the workbench silently disappears from a real Web deployment:
 *
 * - `dsh.client.platform` missing: the client-module scan ignores the package;
 * - `exports["./client"]` missing or moved: boot fails loudly;
 * - the page bundle registering an id other than the package name: the row's
 *   module is never found in the shell's table;
 * - the **contract** artifact wrapped as a page bundle, or reaching for
 *   something outside itself: another plugin inlines it, so either would break
 *   that plugin's build with no error here.
 *
 * It reads `lib/`, so `pnpm run build` must run first.
 *
 * @module @free-lzj/dsh-console/tests/package-faces
 */

import { existsSync, readFileSync } from 'node:fs'
// Node's own URL, not the page's: the jsdom environment replaces the global
// `URL` with jsdom's, which resolves a relative reference against the document
// base and would hand `fs` a non-file URL.
import { URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The package root, used to resolve every manifest path and the artifacts. */
const PACKAGE_ROOT = new NodeURL('../', import.meta.url)

/** The subset of `package.json` this spec holds the harness's contract against. */
interface Manifest {
  readonly name: string
  readonly main: string
  readonly exports: Readonly<Record<string, string | { readonly default?: string }>>
  readonly files: readonly string[]
  readonly dsh?: { readonly client?: { readonly platform?: string } }
}

const manifest = JSON.parse(readFileSync(new NodeURL('package.json', PACKAGE_ROOT), 'utf8')) as Manifest

/** Read one built artifact. @returns its text, or undefined before a build. */
function read(relative: string): string | undefined {
  try {
    return readFileSync(new NodeURL(relative, PACKAGE_ROOT), 'utf8')
  } catch {
    return undefined
  }
}

const bundle = read('lib/client.js')
const contract = read('lib/contract.js')

/** One `load` request a page bundle makes at evaluation time. */
interface LoadRequest {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => unknown
}

/**
 * Module specifiers the shell seeds into its client module table. Spelled here
 * rather than imported from the build config on purpose: this is the shell's
 * list, and the point of the case below is that the bundle asks for nothing
 * beyond it.
 */
const SEEDED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/**
 * A stand-in for every platform module: callable, constructable, and answering
 * any property, so a bundle's own top level materializes.
 */
type PlatformStub = {
  (...args: unknown[]): PlatformStub
  new (...args: unknown[]): unknown
  readonly [property: string]: PlatformStub
}

const platformStub: PlatformStub = new Proxy(function platformStub() {} as unknown as PlatformStub, {
  get: (_target, key) => (key === 'then' ? undefined : platformStub),
  apply: () => platformStub,
  construct: () => platformStub,
})

/** Resolve one manifest export to the file it names. */
function exportPath(specifier: string): string | undefined {
  const entry = manifest.exports[specifier]
  if (entry === undefined) return undefined
  return typeof entry === 'string' ? entry : entry.default
}

describe('package faces', () => {
  it('declares the browser face the client module system looks for', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(exportPath('./client')).toBe('./lib/client.js')
    expect(exportPath('./contract')).toBe('./lib/contract.js')
    expect(exportPath('.')).toBe('./lib/index.js')
    expect(manifest.main).toBe('lib/index.js')
  })

  it('ships all three artifacts in the published payload', () => {
    for (const artifact of ['lib/index.js', 'lib/client.js', 'lib/contract.js']) {
      expect(manifest.files).toContain(artifact)
    }
    for (const specifier of ['.', './client', './contract']) {
      expect(existsSync(new NodeURL(exportPath(specifier) ?? '', PACKAGE_ROOT))).toBe(true)
    }
  })

  it.skipIf(bundle === undefined)('registers the page bundle under this package\'s name and seeds itself from the shell table only', () => {
    const slot = window as unknown as { __ModuleLoader__?: { load(request: LoadRequest): void } }
    const previous = slot.__ModuleLoader__
    const registrations = new Map<string, LoadRequest['factory']>()
    const asked = new Set<string>()
    slot.__ModuleLoader__ = { load: ({ id, factory }) => { registrations.set(id, factory) } }
    try {
      // Indirect eval: the bundle is fetched as text and evaluated in the page's
      // own global scope, exactly as the shell loads it.
      ;(0, eval)(bundle as string)
    } finally {
      if (previous === undefined) delete slot.__ModuleLoader__
      else slot.__ModuleLoader__ = previous
    }

    expect([...registrations.keys()]).toEqual([manifest.name])
    const factory = registrations.get(manifest.name)
    expect(factory).toBeTypeOf('function')

    const exports = factory!((specifier) => { asked.add(specifier); return platformStub }) as Record<string, unknown>
    expect(Object.keys(exports).sort()).toEqual([
      'CONSOLE_PANEL_ID', 'CONSOLE_SERVICE', 'ConsoleIcon', 'NS', 'SETTINGS_ROW_ID',
      'apply', 'consoleService', 'inject', 'useConsolePanel',
    ])
    expect([...(exports.inject as readonly string[])]).toEqual(['slots', 'locale', 'layout'])
    expect(exports.NS).toBe('console')
    expect(exports.consoleService).toBeTypeOf('function')
    expect(exports.useConsolePanel).toBeTypeOf('function')
    expect(exports.apply).toBeTypeOf('function')

    const unseeded = [...asked].filter(specifier => !SEEDED.has(specifier))
    expect(unseeded, `bundle asked for modules the shell does not seed: ${unseeded.join(', ')}`).toEqual([])
  })

  it.skipIf(contract === undefined)('ships a contract another plugin can inline', () => {
    const text = contract as string
    // A page bundle would register with the shell's table; the contract is a
    // plain module another package's build resolves and inlines.
    expect(text).not.toContain('__ModuleLoader__')
    expect(text).not.toContain('window.')
    // It must not reach for a bundle only this package's own page load provides.
    expect(text).not.toMatch(/\bfrom\s+['"][^.'"]/)
    expect(text).not.toMatch(/\brequire\(/)
    // …while still exporting what an adopting plugin calls.
    expect(text).toContain('useConsolePanel')
    expect(text).toContain('CONSOLE_SERVICE')
  })
})
