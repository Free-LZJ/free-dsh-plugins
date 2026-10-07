import { defineConfig } from 'tsdown'

/**
 * The module specifiers the DeepSeek Harness Web shell seeds into its client
 * module table (the shared browser platform). A client bundle must import these
 * rather than inline a second React or a second slot registry.
 */
const PLATFORM_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * @param specifier - module specifier the bundle reached.
 * @returns whether the shell's module table answers this specifier.
 */
const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)

/**
 * The package name a browser bundle registers itself under in the shell's module
 * table. It is the package's own name: the client module system attaches the
 * bundle to the Loader row that mounts this package.
 */
const PACKAGE_NAME = '@free-lzj/dsh-agent-import'

/**
 * Both faces of this dual-face package: the Host plugin the Loader row mounts,
 * and the Settings page the same row's `dsh.client` declaration attaches to
 * it in the browser. A bare specifier reached by either face is a dependency
 * (`@deepseek-ai/schemastery`, `yaml`) or a peer the harness provides
 * (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-mcp-client`,
 * `@deepseek-ai/dsh-skill`): the Node face keeps exactly the package's declared
 * dependencies and peers external, so the artifact loads the runtime's own
 * instances — and, unlike any explicit `deps` setting tried here, still inlines
 * the package's own relative modules.
 */
export default defineConfig([
  {
    name: `${PACKAGE_NAME}/node`,
    // Bundle what tsc emitted, not the sources: that pass rewrites the `.ts`
    // specifiers this repository writes for local imports into the `.js` ones a
    // Node consumer can resolve.
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    // `index.js`, not the `.mjs` a Node-platform ESM face defaults to: the
    // manifest, the Loader row, and the published payload all name that file.
    outputOptions: { entryFileNames: 'index.js' },
  },
  {
    // The shell fetches this bundle outside Vite's module graph and evaluates it
    // as a closure factory: it registers with the module table, receives the
    // table as its `require`, and returns the module exports. The banner,
    // footer, and intro are what make the artifact that shape — a plain CJS
    // bundle would reference an `exports` the browser never defines.
    //
    // Only `src/client/**` reaches this entry. The Host half's modules are not
    // browser code: the client graph may take their *types* (erased), never
    // their values, or this bundle would inline `yaml` and the MCP client.
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: isPlatformModule, alwaysBundle: (specifier: string) => !isPlatformModule(specifier) },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // No `import()` in this package, so every static relative dependency stays
      // in the entry; the name is pinned for a future async chunk.
      chunkFileNames: 'client.[name].js',
      banner: (chunk: { isEntry: boolean; fileName: string }): string =>
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
