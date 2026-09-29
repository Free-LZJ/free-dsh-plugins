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
 * A bare specifier is a runtime dependency the harness installs (`@deepseek-ai/cordis`)
 * or a peer it provides, so it stays an import.
 * @param specifier - module specifier the bundle reached.
 * @returns whether the specifier stays an import.
 */
const isNodeExternal = (specifier: string): boolean => !specifier.startsWith('.')

export default defineConfig([
  {
    // The node half is an empty apply: it exists only so the package holds a
    // Loader row the client module system attaches the browser half to.
    name: '@free-lzj/dsh-client-ui-settings-agent-import/node',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    // `index.js`, not `index.mjs`: the manifest and the published payload name that file.
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: isNodeExternal },
  },
  {
    // The shell fetches this bundle outside Vite's module graph and runs it as a
    // factory with the module table as its `require`, so it is a browser CJS bundle.
    name: '@free-lzj/dsh-client-ui-settings-agent-import/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // `client.js`, not `client.cjs`: the module table fetches exactly that file.
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: isPlatformModule, alwaysBundle: (specifier: string) => !isPlatformModule(specifier) },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
  },
])
