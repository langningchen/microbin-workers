import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ConfigError } from './config';
import { HttpError } from './errors';
import { basicAuth } from './middleware/auth';
import { context } from './middleware/context';
import { crossOriginProtection } from './middleware/csrf';
import { requestLogger } from './middleware/logging';
import { securityHeaders } from './middleware/security';
import { adminRoutes } from './routes/admin';
import { apiRoutes } from './routes/api';
import { compatRoutes } from './routes/compat';
import { fileRoutes } from './routes/files';
import { wantsJson } from './routes/helpers';
import { manageRoutes } from './routes/manage';
import { pageRoutes } from './routes/pages';
import { viewRoutes } from './routes/view';
import type { AppEnv } from './types';
import { ErrorPage } from './views/layout';

export const app = new Hono<AppEnv>();

app.use('*', requestLogger);
app.use('*', securityHeaders);
app.use('*', context);
app.use('*', crossOriginProtection);

// Optional HTTP Basic Auth (BASIC_AUTH_*) protects everything that creates, lists or manages
// uploads. Reading an upload through its link stays public, exactly like upstream MicroBin.
for (const path of ['/', '/upload', '/list', '/edit/*', '/remove/*', '/admin', '/admin/*']) {
  app.use(path, basicAuth);
}
// In the API only reading is public: every state-changing call needs the Basic Auth login.
const guardApiWrites = createMiddleware<AppEnv>((c, next) =>
  c.req.method === 'GET' ? next() : basicAuth(c, next),
);
app.use('/api/*', guardApiWrites);

app.route('/', pageRoutes);
app.route('/', viewRoutes);
app.route('/', fileRoutes);
app.route('/', manageRoutes);
app.route('/', adminRoutes);
app.route('/', apiRoutes);
app.route('/', compatRoutes);

function respondError(
  c: Parameters<typeof wantsJson>[0],
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response | Promise<Response> {
  if (wantsJson(c) || !c.get('cfg')) {
    return c.json({ error: { code, message } }, status as 400, {
      'Cache-Control': 'no-store',
      ...headers,
    });
  }
  return c.html(<ErrorPage cfg={c.get('cfg')} status={status} message={message} />, status as 400, {
    'Cache-Control': 'no-store',
    ...headers,
  });
}

app.notFound((c) => respondError(c, 404, 'not_found', 'Not Found'));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return respondError(c, error.status, error.code, error.message, error.headers);
  }
  if (error instanceof ConfigError) {
    console.error(JSON.stringify({ message: 'invalid configuration', problems: error.problems }));
    return c.json(
      { error: { code: 'misconfigured', message: 'The server is misconfigured' } },
      500,
    );
  }
  console.error(
    JSON.stringify({
      message: 'unhandled error',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: c.req.path,
    }),
  );
  return respondError(c, 500, 'internal_error', 'Something went wrong');
});
