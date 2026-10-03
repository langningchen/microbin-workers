import { createMiddleware } from 'hono/factory';
import { forbidden } from '../errors';
import type { AppEnv } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-origin protection for state-changing requests, based on what browsers always send:
 * `Sec-Fetch-Site`, falling back to `Origin`. Requests with neither header (curl, scripts) are not
 * browser-driven and therefore not CSRF-able, so they pass.
 *
 * This also protects HTTP Basic Auth, whose credentials browsers attach automatically.
 */
export const crossOriginProtection = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const site = c.req.header('sec-fetch-site');
  if (site) {
    if (site !== 'same-origin' && site !== 'none')
      throw forbidden('Cross-origin request blocked', 'csrf');
    return next();
  }
  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* "null" or garbage */
    }
    if (originHost !== host) throw forbidden('Cross-origin request blocked', 'csrf');
  }
  return next();
});
