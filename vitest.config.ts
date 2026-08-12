import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Single root Vitest config for the whole workspace.
 *
 * `packages/core` is DOM-free by contract (WEB.md §9) but its tests still run in
 * the same happy-dom environment so that `crypto.subtle` and `TextEncoder` are
 * available without per-file environment pragmas.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: [
      'packages/*/tests/**/*.test.ts',
      'extension/tests/**/*.test.ts',
    ],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'extension/src/**'],
    },
  },
  resolve: {
    alias: {
      '@autofill/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./extension/src', import.meta.url)),
      // WXT resolves this through its Vite plugin, which the unit suite does not
      // run. The stub keeps storage-touching modules testable as plain code.
      'wxt/browser': fileURLToPath(new URL('./tests/stubs/wxt-browser.ts', import.meta.url)),
    },
  },
});
