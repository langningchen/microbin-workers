import { deleteCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { HttpError, notFound } from '../errors';
import { safeEqual } from '../lib/safe-equal';
import { sealToken } from '../lib/tokens';
import type { AppEnv } from '../types';
import { ADMIN_COOKIE } from './context';

export const ADMIN_SESSION_SECONDS = 2 * 3600;

function basicCredentials(header: string | undefined): { user: string; pass: string } | null {
  const match = header?.match(/^Basic\s+(\S+)$/i);
  if (!match?.[1]) return null;
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0)),
    );
    const colon = decoded.indexOf(':');
    return colon < 0 ? null : { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

/**
 * Optional site-wide gate (BASIC_AUTH_*) for everything that creates, lists or manages uploads.
 * Reading an upload by its link stays public, exactly like upstream MicroBin.
 */
export const basicAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.get('cfg').basicAuth;
  if (!expected) return next();
  const given = basicCredentials(c.req.header('authorization'));
  // Evaluate both comparisons so timing does not reveal which one failed.
  const [userOk, passOk] = await Promise.all([
    safeEqual(given?.user ?? '', expected.username),
    safeEqual(given?.pass ?? '', expected.password),
  ]);
  if (given && userOk && passOk) return next();
  throw new HttpError(401, 'unauthorized', 'Authentication required', {
    'WWW-Authenticate': 'Basic realm="MicroBin", charset="UTF-8"',
  });
});

/** Admin pages: 404 when no admin is configured (the panel does not exist), else login. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('cfg').admin) throw notFound('Page not found');
  if (!c.get('admin')) return c.redirect('/admin/login');
  return next();
});

export async function startAdminSession(c: Context<AppEnv>): Promise<void> {
  const token = await sealToken(c.get('cfg').sessionSecret, 'admin', {
    id: 'admin',
    exp: c.get('now') + ADMIN_SESSION_SECONDS,
  });
  setCookie(c, ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: c.get('origin').startsWith('https:'),
    sameSite: 'Strict',
    path: '/',
    maxAge: ADMIN_SESSION_SECONDS,
  });
}

export function endAdminSession(c: Context<AppEnv>): void {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
}
