import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { configFor } from '../config';
import { openToken } from '../lib/tokens';
import { nowSeconds } from '../lib/time';
import type { AppEnv } from '../types';

export const ADMIN_COOKIE = 'mb_admin';

/** Resolves configuration, client address, public origin and the admin session for a request. */
export const context = createMiddleware<AppEnv>(async (c, next) => {
  const cfg = configFor(c.env);
  const now = nowSeconds();
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const origin = cfg.publicUrl || (forwardedProto ? `${forwardedProto}://${url.host}` : url.origin);

  c.set('cfg', cfg);
  c.set('now', now);
  c.set('ip', c.req.header('cf-connecting-ip') ?? 'local');
  c.set('origin', origin);

  const session = await openToken(cfg.sessionSecret, 'admin', getCookie(c, ADMIN_COOKIE), now);
  c.set('admin', Boolean(cfg.admin && session?.id === 'admin'));
  await next();
});
