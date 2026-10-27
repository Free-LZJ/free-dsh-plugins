import { defineConfig } from 'tsdown'

/**
 * One Host-side library: the decision core reads and writes files, so it is Node
 * code with no browser half, no module table and no Loader row. Nothing here is
 * a platform module — the kernel imports `node:fs` and nothing else — so the
 * bundle is self-contained.
 */
export default defineConfig({
  name: '@free-lzj/dsh-decision/node',
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
  // manifest and the published payload both name that file.
  outputOptions: { entryFileNames: 'index.js' },
})
