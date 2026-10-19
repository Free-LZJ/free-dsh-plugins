import { defineConfig } from 'tsdown'

/**
 * The Host face only: this package registers a search provider into `ctx.web`
 * and has no browser half, so there is no client bundle and no module table to
 * join. Bare specifiers stay external so the artifact uses the runtime's own
 * `@deepseek-ai/dsh-web` and `@deepseek-ai/schemastery` instances — a second
 * copy of either would register into, or validate against, the wrong registry.
 */
export default defineConfig({
  name: '@free-lzj/dsh-web-search-account/node',
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
