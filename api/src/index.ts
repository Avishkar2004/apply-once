import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { AppBindings } from './env';
import { corsHeaders } from './middleware';
import { accountRoutes } from './routes/account';
import { authRoutes } from './routes/auth';
import { blobRoutes } from './routes/blob';
import { syncRoutes } from './routes/sync';

/**
 * AutoFill sync service (WEB.md §8).
 *
 * "Deliberately small. It stores opaque bytes and hands them back."
 *
 * There is no route here that can read a user's data. Event payloads are
 * AES-GCM ciphertext sealed with a key derived on the client; blobs are the
 * same. §10: "The server cannot learn *which companies*, *which roles*, *what
 * you wrote*, or *whether you were rejected*."
 *
 * What it deliberately does *not* do is as important as what it does: no
 * server-side search (it cannot index ciphertext), no analytics, no projection.
 * Those all run on the client — see §6.3.
 */
const app = new Hono<AppBindings>();

app.use('*', async (context, next) => {
  await next();
  for (const [header, value] of Object.entries(
    corsHeaders(context.env, context.req.header('Origin')),
  )) {
    context.header(header, value);
  }
});

app.options('*', (context) => context.body(null, 204));

app.get('/health', (context) => context.json({ ok: true }));

app.route('/auth', authRoutes);
app.route('/sync', syncRoutes);
app.route('/blob', blobRoutes);
app.route('/account', accountRoutes);

/**
 * One error shape for everything.
 *
 * Validation failures return which field was wrong but never echo the value —
 * a 400 that quotes back an auth key would put it in a log.
 */
app.onError((error, context) => {
  if (error instanceof HTTPException) {
    return error.res ?? context.json({ error: error.message }, error.status);
  }
  if (error instanceof ZodError) {
    return context.json(
      {
        error: 'Invalid request.',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  console.error('unhandled error', error);
  return context.json({ error: 'Internal error.' }, 500);
});

app.notFound((context) => context.json({ error: 'Not found.' }, 404));

export default app;
