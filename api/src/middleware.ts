import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Context, Env as HonoEnv } from 'hono';
import type { AppBindings, Env } from './env';
import { readSession, SESSION_COOKIE, touchSession } from './auth/session';
import { findAccountById } from './accounts';

/**
 * Read the session id from either transport.
 *
 * The web app is a same-site browser page and uses the `HttpOnly; Secure;
 * SameSite=Strict` cookie of WEB.md §7. **The extension cannot.** Its requests
 * originate from a `chrome-extension://` service worker, which is not same-site
 * with the API origin, so a `Strict` cookie is not attached — and relaxing it to
 * `SameSite=None` to accommodate one client would expose the *browser* client to
 * cross-site request forgery.
 *
 * So the extension sends `Authorization: Bearer <sessionId>` instead. That is
 * strictly safer for it than a cookie: an extension request carries no ambient
 * credential, so there is nothing for a hostile page to trigger.
 *
 * The cookie is checked first, so a browser session cannot be overridden by an
 * attacker-supplied header.
 */
function readSessionId<E extends HonoEnv>(context: Context<E>): string | undefined {
  const cookie = getCookie(context, SESSION_COOKIE);
  if (cookie) return cookie;

  const authorization = context.req.header('Authorization');
  if (!authorization) return undefined;

  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * The session guard.
 *
 * Every route past this point has a `userId`, and every query it makes is
 * scoped by that id. Tenant isolation in this service is exactly one rule —
 * *no SQL anywhere selects rows without `user_id = ?`* — and this middleware is
 * what makes that rule expressible.
 */
export const requireSession = createMiddleware<AppBindings>(async (context, next) => {
  const sessionId = readSessionId(context);
  if (!sessionId) throw new HTTPException(401, { message: 'Not signed in.' });

  const session = await readSession(context.env, sessionId);
  if (!session) throw new HTTPException(401, { message: 'Session expired.' });

  context.set('userId', session.userId);
  context.set('sessionId', sessionId);

  await touchSession(context.env, sessionId, session);
  await next();
});

/**
 * §10 — "A 'web access off' account switch that makes the server reject all
 * `/sync` reads for that account, for people who want the extension's
 * guarantees without the website's weakness."
 *
 * Applied to sync and blob reads, not to auth: a user who has turned web access
 * off must still be able to sign in and turn it back on.
 */
export const requireWebAccess = createMiddleware<AppBindings>(async (context, next) => {
  const userId = context.get('userId');
  if (!userId) throw new HTTPException(401, { message: 'Not signed in.' });

  const account = await findAccountById(context.env, userId);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  if (account.web_access !== 1) {
    throw new HTTPException(403, {
      message: 'Web access is turned off for this account. Re-enable it from the extension.',
    });
  }
  await next();
});

/**
 * CORS for the web app's origin only.
 *
 * `credentials: true` with a wildcard origin is rejected by browsers, and would
 * be wrong anyway — the session cookie must only be sent from the one origin we
 * serve. The extension calls this API from its own origin and does not need to
 * be listed: extension requests carry their host permission instead.
 */
export function corsHeaders(env: Env, origin: string | undefined): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN;
  if (!allowed || origin !== allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    Vary: 'Origin',
  };
}
