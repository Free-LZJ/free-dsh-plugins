import { defineConfig } from 'tsdown'

/**
 * A bare specifier is a dependency (`@deepseek-ai/schemastery`, `yaml`) or a peer
 * the harness provides (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-mcp-client`,
 * `@deepseek-ai/dsh-skill`). tsdown's default already keeps exactly the package's
 * declared dependencies and peers external, so the artifact loads the runtime's
 * own instances — and, unlike any explicit `deps` setting tried here, still
 * inlines the package's own relative modules.
 */
export default defineConfig({
  name: '@free-lzj/dsh-agent-import/node',
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
})
