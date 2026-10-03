import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Config } from '../config';
import { formatUtc, isoUtc } from '../lib/time';
import { asset } from './assets';

/** JSON that is safe inside <script type="application/json"> (no "</script>" breakout). */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export interface LayoutProps {
  cfg: Config;
  title?: string;
  /** Page bundles to load in addition to common.js. */
  scripts?: ('create.js' | 'paste.js')[];
  /** Data for the page's script, exposed as <script id="boot">. */
  boot?: unknown;
}

const Header: FC<{ cfg: Config }> = ({ cfg }) => (
  <nav id="nav">
    <b class="brand">
      {!cfg.hideLogo && (
        <a href="/" class="logo-link">
          <img src="/logo.png" width="100" alt="MicroBin" />
        </a>
      )}
      {cfg.title}
    </b>
    <a href="/">New</a>
    {!cfg.noListing && <a href="/list">List</a>}
    <a href="/guide">Guide</a>
  </nav>
);

const Footer: FC<{ cfg: Config }> = ({ cfg }) => (
  <p id="footer">
    {cfg.footerText ? (
      raw(cfg.footerText) // trusted: set by the administrator in wrangler.jsonc
    ) : (
      <>
        <a href="https://microbin.eu">MicroBin</a> by Dániel Szabó and the FOSS Community, rewritten
        for Cloudflare Workers. Let's keep the Web <b>compact</b>, <b>accessible</b> and{' '}
        <b>humane</b>!
      </>
    )}
  </p>
);

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  cfg,
  title,
  scripts = [],
  boot,
  children,
}) => {
  const siteTitle = cfg.title || 'MicroBin';
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="robots" content="noindex, nofollow" />
          <title>{title ? `${title} · ${siteTitle}` : siteTitle}</title>
          <link rel="icon" href="/favicon.ico" />
          {cfg.shortUrl && <meta name="short-url" content={cfg.shortUrl} />}
          <link rel="stylesheet" href={asset('app.css')} />
          {cfg.customCss && <link rel="stylesheet" href={cfg.customCss} />}
        </head>
        <body class={cfg.wide ? 'wide' : undefined}>
          {!cfg.hideHeader && <Header cfg={cfg} />}
          <main>{children}</main>
          {!cfg.hideFooter && <Footer cfg={cfg} />}
          {boot !== undefined && (
            <script
              type="application/json"
              id="boot"
              dangerouslySetInnerHTML={{ __html: safeJson(boot) }}
            />
          )}
          <script type="module" src={asset('common.js')} />
          {scripts.map((name) => (
            <script type="module" src={asset(name)} />
          ))}
        </body>
      </html>
    </>
  );
};

/** Timestamps render in UTC; common.js upgrades them to the visitor's local time zone. */
export const Time: FC<{ ts: number }> = ({ ts }) => (
  <time datetime={isoUtc(ts)}>{formatUtc(ts)}</time>
);

export const ErrorPage: FC<{ cfg: Config; status: number; message: string }> = ({
  cfg,
  status,
  message,
}) => (
  <Layout cfg={cfg} title={String(status)}>
    <h2>{status}</h2>
    <p>
      <b>{message}</b>
    </p>
    <p>
      <a href="/">Go home</a>
    </p>
  </Layout>
);

/** Small "Incorrect password" style notice. */
export const Notice: FC<{ kind?: 'error' | 'ok'; message?: string | undefined }> = ({
  kind = 'error',
  message,
}) =>
  message ? (
    <p class={`notice ${kind}`} role="alert">
      {message}
    </p>
  ) : (
    <></>
  );
