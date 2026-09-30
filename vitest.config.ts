import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The published dsh packages ship no source maps while their bundles reference
  // them; Vite's per-file warnings about that would bury real output.
  logLevel: 'error',
  // The client specs render `.tsx` components; the host specs stay plain TypeScript.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
    // Installs the harness Web shell's module table before any spec imports a
    // published browser bundle (a no-op outside jsdom).
    setupFiles: ['packages/agent-import/tests/support/module-loader.ts'],
    // The live-configuration specs drive the real Loader, which mounts and disposes fibers.
    testTimeout: 20_000,
    server: {
      deps: {
        // The harness publishes its browser-facing UI packages as Node halves whose
        // imports stay external (`clsx`, `shiki`, `katex`, CSS modules, …), with no
        // browser bundle to load instead. Vite must transform them — and answer the
        // CSS imports — exactly as the harness's own GUI lane does.
        inline: [/@deepseek-ai\/dsh-client-/],
      },
    },
  },
})
