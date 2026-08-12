/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as AppEnv } from './src/env';

/**
 * Teach `cloudflare:test` about this Worker's bindings.
 *
 * The pool types `env` as `Cloudflare.Env`, an interface projects are expected
 * to augment. Pointing it at the same `Env` the Worker itself uses means a
 * binding added in one place cannot be forgotten in the other.
 */
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}

export {};
