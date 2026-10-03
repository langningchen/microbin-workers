import { createMiddleware } from 'hono/factory';
import type { Config } from '../config';
import type { AppEnv } from '../types';

/**
 * Strict CSP: no inline scripts or styles at all (pages only reference same-origin bundles and
 * pass data through <script type="application/json">). User files get an even stricter,
 * sandboxed policy in the file route.
 */
export function contentSecurityPolicy(config: Config): string {
  const styleSources = ["'self'"];
  if (config.customCss.startsWith('http')) styleSources.push(new URL(config.customCss).origin);
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src ${styleSources.join(' ')}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  // cfg is missing only when the configuration itself is broken; stay strict regardless.
  const cfg = c.get('cfg') as Config | undefined;
  const headers = c.res.headers;
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  set('Content-Security-Policy', cfg ? contentSecurityPolicy(cfg) : "default-src 'none'");
  set('X-Content-Type-Options', 'nosniff');
  set('Referrer-Policy', 'no-referrer');
  set('X-Frame-Options', 'DENY');
  set('Cross-Origin-Opener-Policy', 'same-origin');
  set('Cross-Origin-Resource-Policy', 'same-origin');
  set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (c.get('origin')?.startsWith('https:')) {
    set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});
