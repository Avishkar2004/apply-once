/**
 * @autofill/core — the shared package.
 *
 * Hard constraint (WEB.md §9): no DOM access, no `chrome.*`. This code runs in a
 * service worker, in a browser tab, and in Vitest, and every client must compute
 * identical results from it.
 */
export * from './schema/index';
export * from './crypto/index';
export * from './sync/index';
export * from './util/index';
