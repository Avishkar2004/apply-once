import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

/**
 * Tests run inside a real `workerd`, against real D1, KV and R2 — not mocks.
 *
 * That matters more here than it usually would. The two things most likely to
 * be wrong in this service are the per-user `seq` counter under D1's batching
 * semantics, and the tenant-isolation predicate on every query. Neither is
 * observable against a fake database.
 *
 * W3's done-criterion (WEB.md §11) is "curl can push and pull envelopes
 * idempotently" — these tests are that, automated.
 *
 * Note: `@cloudflare/vitest-pool-workers` 0.21 replaced the old
 * `defineWorkersConfig` helper with the `cloudflareTest` Vite plugin.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Storage is reset explicitly in each suite's `beforeEach`, so a test that
      // leaks state fails loudly rather than being papered over by the harness.
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        kvNamespaces: ['SESSIONS'],
        r2Buckets: ['BLOBS'],
        bindings: {
          SERVER_SECRET: 'test-server-secret-not-a-real-one',
          ALLOWED_ORIGIN: 'https://app.autofill.dev',
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    // Auth tests do several 100k-iteration PBKDF2 derivations each, inside
    // workerd. That cost is deliberate — it is what makes a stolen auth hash
    // useless — so the timeout accommodates it rather than the iteration count
    // being lowered to suit the suite.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@autofill/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
