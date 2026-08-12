import {
  DEFAULT_PULL_LIMIT,
  PULL_RESPONSE,
  PUSH_RESPONSE,
  type PullResponse,
  type PushedEnvelope,
  type PushResponse,
} from './envelope';

/**
 * The HTTP client for the sync service.
 *
 * Kept behind an interface so the loop can be tested without a network, and so
 * a future web client can supply a cookie-based implementation while the
 * extension supplies the bearer one.
 */

export interface SyncApi {
  push(events: PushedEnvelope[]): Promise<PushResponse>;
  pull(since: number, limit?: number): Promise<PullResponse>;
}

/**
 * Errors the loop must distinguish, because each demands a different response
 * and treating them alike loses or duplicates data.
 */
export type SyncFailureKind =
  /** 401 — the session is gone. Stop; the user must sign in again. */
  | 'unauthenticated'
  /** 403 — web access is off for this account (§10). Stop quietly. */
  | 'forbidden'
  /** 413 — the account is at its quota (§8). Stop; pushing more cannot help. */
  | 'quota'
  /** 4xx we do not understand. A bug on one side; do not retry blindly. */
  | 'rejected'
  /** 5xx or a transport failure. Safe to retry later. */
  | 'transient';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncError';
  }

  /** Whether the same request can simply be sent again on the next tick. */
  get retryable(): boolean {
    return this.kind === 'transient';
  }
}

export interface HttpSyncApiOptions {
  baseUrl: string;
  /**
   * The session credential. Read per request rather than captured, so a token
   * refreshed mid-session is picked up without rebuilding the client.
   */
  token: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createHttpSyncApi(options: HttpSyncApiOptions): SyncApi {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = options.token();
    if (!token) throw new SyncError('unauthenticated', 'Not signed in to sync.');

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          // The extension is not same-site with the API, so a SameSite=Strict
          // cookie is never attached — see api/src/middleware.ts.
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (cause) {
      // Offline, DNS failure, TLS failure. Always safe to retry.
      throw new SyncError('transient', `Could not reach the sync service: ${String(cause)}`);
    }

    if (response.ok) return response.json();

    const detail = await response.text().catch(() => '');
    throw new SyncError(kindFor(response.status), detail || response.statusText, response.status);
  }

  return {
    async push(events) {
      // Validate the response rather than trusting it: a proxy that mangles the
      // body must not be able to make the client mark events synced that are not.
      return PUSH_RESPONSE.parse(
        await call('/sync/push', { method: 'POST', body: JSON.stringify({ events }) }),
      );
    },

    async pull(since, limit = DEFAULT_PULL_LIMIT) {
      return PULL_RESPONSE.parse(
        await call(`/sync/pull?since=${since}&limit=${limit}`, { method: 'GET' }),
      );
    },
  };
}

function kindFor(status: number): SyncFailureKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 413) return 'quota';
  if (status >= 500) return 'transient';
  // 429 is a server saying "later", which is exactly what transient means.
  if (status === 429) return 'transient';
  return 'rejected';
}
