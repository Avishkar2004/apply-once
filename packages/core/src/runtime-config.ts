import { config as zodConfig } from 'zod';

/**
 * Turn off Zod's JIT schema compiler. **Import this before any schema.**
 *
 * Zod 4 compiles validators with `new Function` for speed, and feature-detects
 * that with a `Function("")` probe. Every environment this package runs in
 * forbids it: an MV3 extension page under `script-src 'self'`, and Cloudflare
 * Workers. Zod catches the failure and falls back correctly on its own, so this
 * is not a correctness fix — but the probe still trips the browser's CSP
 * reporter, and shipping a red "CSP prevents evaluation of arbitrary strings"
 * warning in the console of a privacy-focused product is its own problem.
 *
 * This lives in its own module rather than at the top of `index.ts` because
 * `export * from './schema/…'` is an *import declaration*: ES modules hoist it
 * and evaluate it before any statement in the importing module's body. A
 * `zodConfig()` call in that body therefore runs after the schemas it was meant
 * to configure. A dedicated module, imported first, is evaluated first.
 */
zodConfig({ jitless: true });
