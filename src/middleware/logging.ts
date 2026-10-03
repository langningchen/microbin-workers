import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

/**
 * One structured JSON line per request (searchable in Workers Observability). The query string is
 * deliberately left out: it can carry short-lived access tokens.
 */
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const started = Date.now();
  await next();
  const status = c.res.status;
  const line = JSON.stringify({
    message: 'request',
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status,
    ms: Date.now() - started,
    ray: c.req.header('cf-ray'),
    country: c.req.header('cf-ipcountry'),
  });
  if (status >= 500) console.error(line);
  else console.log(line);
});
