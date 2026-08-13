/**
 * @autofill/core — the shared package.
 *
 * Hard constraint (WEB.md §9): no DOM access, no `chrome.*`. This code runs in a
 * service worker, in a browser tab, and in Vitest, and every client must compute
 * identical results from it.
 */
// Must be first: disables Zod's `new Function` JIT before any schema is built.
import './runtime-config';

export * from './schema/index';
export * from './crypto/index';
export * from './sync/index';
export * from './util/index';
