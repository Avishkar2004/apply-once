import type { Env } from '../env';

/**
 * Login rate limiting (WEB.md §7).
 *
 * "Rate limit login to 10 attempts per 15 minutes per IP and per account. The
 * auth key is high-entropy, so this is belt-and-braces."
 *
 * Both dimensions matter and they defend different things: per-account stops
 * someone grinding one victim from a botnet, per-IP stops one host sweeping
 * many accounts. Either alone leaves the other attack open.
 *
 * Counters live in KV with a TTL, so a window expires by itself. KV is
 * eventually consistent, which means a determined attacker racing many
 * concurrent requests can overshoot the limit slightly. That is acceptable
 * here — §7 calls this belt-and-braces over a 256-bit key, not the primary
 * control — and the alternative (a Durable Object per account) is a lot of
 * machinery for a bound that does not need to be exact.
 */

export const MAX_ATTEMPTS = 10;
export const WINDOW_SECONDS = 15 * 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets — surfaced as `Retry-After`. */
  retryAfter: number;
}

async function bump(env: Env, key: string): Promise<number> {
  const raw = await env.SESSIONS.get(key);
  const count = raw ? Number.parseInt(raw, 10) + 1 : 1;
  // The TTL is set from the first attempt, so the window is fixed rather than
  // sliding — an attacker cannot extend it by continuing to try.
  await env.SESSIONS.put(key, String(count), {
    expirationTtl: raw ? undefined : WINDOW_SECONDS,
  });
  return count;
}

/**
 * Count an attempt against both dimensions. Call before verifying, so a failed
 * verification cannot be retried for free.
 */
export async function checkLoginRate(
  env: Env,
  email: string,
  ip: string,
): Promise<RateLimitResult> {
  const [byAccount, byIp] = await Promise.all([
    bump(env, `rate:login:account:${email}`),
    bump(env, `rate:login:ip:${ip}`),
  ]);

  const worst = Math.max(byAccount, byIp);
  return {
    allowed: worst <= MAX_ATTEMPTS,
    remaining: Math.max(0, MAX_ATTEMPTS - worst),
    retryAfter: WINDOW_SECONDS,
  };
}

/** A successful login clears the account counter so a typo is not punitive. */
export async function clearLoginRate(env: Env, email: string): Promise<void> {
  await env.SESSIONS.delete(`rate:login:account:${email}`);
}

/** Cloudflare sets this on every request; the fallback only matters in tests. */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
