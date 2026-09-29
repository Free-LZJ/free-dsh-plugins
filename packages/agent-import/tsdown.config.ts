import { defineConfig } from 'tsdown'

/**
 * A bare specifier is a dependency (`@deepseek-ai/schemastery`, `yaml`) or a peer
 * the harness provides (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-mcp-client`,
 * `@deepseek-ai/dsh-skill`), so the bundle imports it instead of inlining a
 * second copy of the runtime instance.
 * @param specifier - module specifier the bundle reached.
 * @returns whether the specifier stays an import.
 */
const external = (specifier: string): boolean => !specifier.startsWith('.')

export default defineConfig({
  name: '@free-lzj/dsh-agent-import/node',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  // `index.js`, not `index.mjs`: the manifest, the Loader row, and the published payload name that file.
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: external },
})
