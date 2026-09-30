// @vitest-environment jsdom
/**
 * The package's two faces, checked at the boundary the harness actually crosses.
 *
 * Every other spec in this directory drives sources. This one drives the BUILT
 * browser bundle and the manifest declaration the client module system reads,
 * because four mistakes here have no other coverage — each leaves the source
 * specs green while the card, or the whole plugin, silently disappears from a
 * real Web deployment:
 *
 * - `dsh.client.platform` missing: the scan ignores the package entirely;
 * - `exports["./client"]` missing or pointing elsewhere: boot fails loudly;
 * - the bundle registering an id other than the package name: the row's module
 *   is never found in the shell's table;
 * - a Host value-import reached from `src/client/**`: the bundle asks the shell
 *   for a module it does not seed and throws in the browser.
 *
 * It reads `lib/`, so `pnpm run build` must run first; without a build the third
 * case reports as skipped.
 */
import { existsSync, readFileSync } from 'node:fs'
// Node's own URL, not the page's: the jsdom environment replaces the global
// `URL` with jsdom's, which resolves a relative reference against the document
// base (`http://localhost:3000/`) and would hand `fs` a non-file URL.
import { URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The package root, used to resolve every manifest path and the bundle. */
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

/** Browser bundle the shell fetches, absent until the package is built. */
const bundle = readBundle()

/**
 * Read the built browser bundle.
 * @returns its text, or `undefined` before the package has been built.
 */
function readBundle(): string | undefined {
  try {
    return readFileSync(new NodeURL('lib/client.js', PACKAGE_ROOT), 'utf8')
  } catch {
    return undefined
  }
}

/** One `load` request a browser bundle makes at evaluation time. */
interface LoadRequest {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => unknown
}

/** The loader slot the shell installs before any bundle is fetched. */
type LoaderSlot = { load(request: LoadRequest): void } | undefined

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
 * any property, so the bundle's own top level materializes. This spec checks
 * wiring, not rendering — the component specs own behaviour.
 */
type PlatformStub = {
  (...args: unknown[]): PlatformStub
  new (...args: unknown[]): PlatformStub
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
    expect(exportPath('.')).toBe('./lib/index.js')
    expect(manifest.main).toBe('lib/index.js')
  })

  it('ships both faces in the published payload', () => {
    expect(manifest.files).toContain('lib/index.js')
    expect(manifest.files).toContain('lib/client.js')
    expect(existsSync(new NodeURL(exportPath('./client') ?? '', PACKAGE_ROOT))).toBe(true)
    expect(existsSync(new NodeURL(exportPath('.') ?? '', PACKAGE_ROOT))).toBe(true)
  })

  it.skipIf(bundle === undefined)('registers under this package\'s own name and seeds itself from the shell table only', () => {
    const code = bundle as string
    const slot = window as unknown as { __ModuleLoader__?: LoaderSlot }
    const previous = slot.__ModuleLoader__
    const registrations = new Map<string, LoadRequest['factory']>()
    const asked = new Set<string>()
    slot.__ModuleLoader__ = { load: ({ id, factory }) => { registrations.set(id, factory) } }
    try {
      // Indirect eval: the bundle is fetched as text and evaluated in the page's
      // own global scope, exactly as the shell loads it.
      ;(0, eval)(code)
    } finally {
      slot.__ModuleLoader__ = previous
    }

    expect([...registrations.keys()]).toEqual([manifest.name])
    const factory = registrations.get(manifest.name)
    expect(factory).toBeTypeOf('function')

    const exports = factory!((specifier) => { asked.add(specifier); return platformStub }) as Record<string, unknown>
    expect(Object.keys(exports).sort()).toEqual(['NS', 'apply', 'inject'])
    expect([...(exports.inject as readonly string[])]).toEqual(['slots', 'locale', 'configForms'])
    expect(exports.NS).toBe('settings.agentImport')
    expect(exports.apply).toBeTypeOf('function')

    // The purity rule the merge makes a directory rule instead of a package
    // rule: nothing outside src/client/** may reach the browser bundle.
    const unseeded = [...asked].filter(specifier => !SEEDED.has(specifier))
    expect(unseeded, `bundle asked for modules the shell does not seed: ${unseeded.join(', ')}`).toEqual([])
  })
})
