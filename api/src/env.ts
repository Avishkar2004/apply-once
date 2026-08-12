/**
 * Worker bindings (WEB.md §8).
 *
 * | Layer    | Choice      | Notes                                    |
 * |----------|-------------|------------------------------------------|
 * | Events   | D1 (SQLite) | `PRIMARY KEY (userId, id)`, index on seq |
 * | Blobs    | R2          | Content-addressed, prefixed by userId    |
 * | Sessions | Workers KV  | Short TTL, cheap reads                   |
 */
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  SESSIONS: KVNamespace;
  /** HMAC key behind the deterministic fake salt for unknown accounts (§7). */
  SERVER_SECRET: string;
  ALLOWED_ORIGIN?: string;
}

/** Set by the auth middleware once a session cookie checks out. */
export interface AuthedVars {
  userId: string;
  sessionId: string;
}

export type AppBindings = { Bindings: Env; Variables: Partial<AuthedVars> };
export type AuthedBindings = { Bindings: Env; Variables: AuthedVars };
