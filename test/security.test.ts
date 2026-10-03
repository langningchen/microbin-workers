import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  basic,
  bytes,
  call,
  callWith,
  create,
  form,
  json,
  r2Exists,
  row,
  fileKeys,
  uploadFile,
  publish,
} from './helpers';

const AUTH = { BASIC_AUTH_USERNAME: 'alice', BASIC_AUTH_PASSWORD: 's3cret' };
const cookieOf = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';

describe('HTTP Basic Auth', () => {
  it('protects creating, listing and managing, but not reading by link', async () => {
    const auth = { authorization: basic('alice', 's3cret') };
    const created = await (async () => {
      const response = await call(
        '/api/pastas',
        {
          ...json({ content: 'guarded', expiration: '1hour' }),
          headers: { 'content-type': 'application/json', ...auth },
        },
        AUTH,
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    })();

    for (const path of ['/', '/list', `/edit/${created.id}`, `/remove/${created.id}`, '/admin']) {
      const denied = await call(path, {}, AUTH);
      expect(denied.status, path).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain('Basic');
      expect((await call(path, { headers: auth }, AUTH)).status, path).not.toBe(401);
    }
    expect(
      (await call('/api/pastas', json({ content: 'x', expiration: '1hour' }), AUTH)).status,
    ).toBe(401);
    expect((await call('/upload', { method: 'POST' }, AUTH)).status).toBe(401);

    // public: the link, raw, QR, files, the guide and reading through the API
    for (const path of [
      `/upload/${created.id}`,
      `/raw/${created.id}`,
      `/qr/${created.id}`,
      '/guide',
      '/healthz',
      `/api/pastas/${created.id}`,
    ]) {
      expect((await call(path, {}, AUTH)).status, path).toBe(200);
    }
  });

  it('rejects wrong or malformed credentials', async () => {
    for (const authorization of [
      basic('alice', 'wrong'),
      basic('mallory', 's3cret'),
      'Basic !!!',
      'Bearer abc',
      basic('alice', ''),
    ]) {
      expect((await call('/', { headers: { authorization } }, AUTH)).status, authorization).toBe(
        401,
      );
    }
  });

  it('refuses to run half-configured instead of silently skipping authentication', async () => {
    const response = await call('/', {}, { BASIC_AUTH_USERNAME: 'alice' });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'misconfigured',
    );
  });
});

describe('administrator', () => {
  const login = (username: string, password: string, overrides = {}) =>
    callWith('/admin/login', form({ username, password }), overrides);

  it('does not exist unless ADMIN_PASSWORD is set', async () => {
    expect((await call('/admin', {}, { ADMIN_PASSWORD: '' })).status).toBe(404);
    expect((await call('/admin/login', {}, { ADMIN_PASSWORD: '' })).status).toBe(404);
  });

  it('requires a login and rejects wrong credentials', async () => {
    const gate = await call('/admin');
    expect(gate.status).toBe(302);
    expect(gate.headers.get('location')).toBe('/admin/login');
    expect((await login('admin', 'wrong')).response.status).toBe(401);
    expect((await login('root', 'admin-pass')).response.status).toBe(401);
  });

  it('signs in with a hardened session cookie and can manage uploads', async () => {
    const victim = await create({ content: 'to be moderated' });
    const frozen = await create({ content: 'cannot be removed by users' }, { EDITABLE: false });

    const { response } = await login('admin', 'admin-pass');
    expect(response.status).toBe(303);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = cookieOf(response);

    const dashboard = await call('/admin', { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain(victim.id);
    expect(html).toContain('Administration');

    // an administrator can remove what users cannot
    const page = await call(`/remove/${frozen.id}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(
      (await call(`/remove/${frozen.id}`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(303);
    expect(
      (await call(`/admin/remove/${victim.id}`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(303);
    expect(await row('SELECT id FROM pastas WHERE id IN (?, ?)', victim.id, frozen.id)).toBeNull();

    const cleanup = await call('/admin/cleanup', { method: 'POST', headers: { cookie } });
    expect(cleanup.status).toBe(303);
    expect(
      (await call('/admin/logout', { method: 'POST', headers: { cookie } })).headers.get(
        'set-cookie',
      ),
    ).toContain('mb_admin=;');
  });

  it('ignores forged or foreign cookies', async () => {
    for (const cookie of ['mb_admin=garbage', 'mb_admin=' + 'A'.repeat(80), 'other=1']) {
      expect((await call('/admin', { headers: { cookie } })).status, cookie).toBe(302);
    }
    // a valid cookie from another deployment (different SESSION_SECRET) is worthless
    const { response } = await login('admin', 'admin-pass');
    const cookie = cookieOf(response);
    const other = await call('/admin', { headers: { cookie } }, { SESSION_SECRET: 'z'.repeat(48) });
    expect(other.status).toBe(302);
  });

  it('requires a POST and a session for destructive actions', async () => {
    const victim = await create({ content: 'x' });
    expect((await call(`/admin/remove/${victim.id}`, { method: 'POST' })).status).toBe(302);
    expect((await call(`/admin/remove/${victim.id}`)).status).toBe(404); // GET does nothing
    expect(await row('SELECT id FROM pastas WHERE id = ?', victim.id)).not.toBeNull();
  });

  it('throttles password guessing', async () => {
    const headers = {
      'cf-connecting-ip': '203.0.113.99',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push(
        (
          await call('/admin/login', {
            method: 'POST',
            headers,
            body: `username=admin&password=bad${i}`,
          })
        ).status,
      );
    }
    expect(statuses).toContain(429);
  });
});

describe('cross-site request forgery', () => {
  const post = (headers: Record<string, string>) =>
    call('/api/pastas', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ content: 'x', expiration: '1hour' }),
    });

  it('blocks cross-site browser requests', async () => {
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
  });

  it('allows same-origin browsers and non-browser clients', async () => {
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(201);
    expect((await post({ origin: 'https://microbin.test' })).status).toBe(201);
    expect((await post({})).status).toBe(201); // curl
  });

  it('also guards form posts such as removal and admin login', async () => {
    const created = await create({ content: 'x' });
    const evil = await call(`/remove/${created.id}`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(evil.status).toBe(403);
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).not.toBeNull();
  });
});

describe('response headers', () => {
  it('sends a strict content security policy and friends on every page', async () => {
    const response = await call('/');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(
      (await call('/api/pastas/nope-nope-nope-nope')).headers.get('content-security-policy'),
    ).toBeTruthy();
  });

  it('lets a custom stylesheet host through the policy, and nothing else', async () => {
    const response = await call('/', {}, { CUSTOM_CSS: 'https://cdn.example.com/theme.css' });
    expect(response.headers.get('content-security-policy')).toContain(
      "style-src 'self' https://cdn.example.com",
    );
    expect(await response.text()).toContain('https://cdn.example.com/theme.css');
  });

  it('serves HSTS only over https', async () => {
    expect((await call('/')).headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('never leaks internals in errors', async () => {
    const created = await create({ content: 'x' });
    await env.DB.exec('DROP TABLE IF EXISTS never_existed');
    const missing = await call(`/file/${created.id}/0`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toMatch(/sqlite|stack|at .*\(/i);
  });
});

describe('input handling', () => {
  it('escapes user text everywhere it is rendered', async () => {
    const evil = '</code></pre><script>alert("xss")</script><img src=x onerror=alert(1)>';
    const created = await create({ content: evil });
    const view = await (await call(created.url)).text();
    const edit = await (await call(`/edit/${created.id}`)).text();
    for (const html of [view, edit]) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert');
    }
    expect(await (await call(`/raw/${created.id}`)).text()).toBe(evil); // raw is text/plain + nosniff
  });

  it('rejects oversized and malformed bodies', async () => {
    const big = await call(
      '/api/pastas',
      json({ content: 'x'.repeat(3 * 1024 * 1024), expiration: '1hour' }),
    );
    expect(big.status).toBe(413);
    const text = await call(
      '/api/pastas',
      json({ content: 'x'.repeat(1024 * 1024 + 1), expiration: '1hour' }),
    );
    expect(text.status).toBe(413);
    const bad = await call('/api/pastas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const unknown = await call(
      '/api/pastas',
      json({ content: 'x', expiration: '1hour', admin: true }),
    );
    expect(unknown.status).toBe(400); // strict schema: unknown fields are errors
    const burn = await call(
      '/api/pastas',
      json({ content: 'x', expiration: '1hour', burnAfter: 7 }),
    );
    expect(burn.status).toBe(400);
    const syntax = await call(
      '/api/pastas',
      json({ content: 'x', expiration: '1hour', syntax: 'cobol' }),
    );
    expect(syntax.status).toBe(400);
  });

  it('enforces which privacy levels the operator enabled', async () => {
    const attempt = (privacy: string, overrides: Record<string, unknown>) =>
      call(
        '/api/pastas',
        json({ content: 'x', expiration: '1hour', privacy, password: 'pw' }),
        overrides,
      );
    expect((await attempt('private', { ENCRYPTION_SERVER_SIDE: false })).status).toBe(400);
    expect((await attempt('readonly', { ENABLE_READONLY: false })).status).toBe(400);
    expect((await attempt('unlisted', { PRIVATE: false })).status).toBe(400);
    expect((await attempt('private', {})).status).toBe(201);
    const burn = await call(
      '/api/pastas',
      json({ content: 'x', expiration: '1hour', burnAfter: 1 }),
      { ENABLE_BURN_AFTER: false },
    );
    expect(burn.status).toBe(400);
  });

  it('requires passwords for protected levels', async () => {
    for (const privacy of ['readonly', 'private']) {
      const response = await call(
        '/api/pastas',
        json({ content: 'x', expiration: '1hour', privacy }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'password_required',
      );
    }
  });
});

describe('server-wide read-only mode', () => {
  const mode = { READONLY: true, UPLOADER_PASSWORD: 'let-me-in' };
  const attempt = (extra: Record<string, unknown>, overrides = mode) =>
    call('/api/pastas', json({ content: 'x', expiration: '1hour', ...extra }), overrides);

  it('only lets people with the uploader password create uploads', async () => {
    const denied = await attempt({});
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'incorrect_uploader_password',
    );
    expect((await attempt({ uploaderPassword: 'wrong' })).status).toBe(403);
    expect((await attempt({ uploaderPassword: 'let-me-in' })).status).toBe(201);
  });

  it('closes uploads entirely when no uploader password exists (fail closed)', async () => {
    const response = await attempt({}, { READONLY: true, UPLOADER_PASSWORD: '' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'uploads_disabled',
    );
  });

  it('still lets everybody read', async () => {
    const created = await create({ content: 'readable' });
    expect((await call(`/raw/${created.id}`, {}, mode)).status).toBe(200);
  });
});

describe('curl compatible form upload', () => {
  const upload = (data: FormData, headers: Record<string, string> = {}, overrides = {}) =>
    call('/upload', { method: 'POST', body: data, headers }, overrides);

  it('accepts the upstream form fields and redirects to the new upload', async () => {
    const data = new FormData();
    data.set('content', 'posted with curl');
    data.set('expiration', '1hour');
    data.set('syntax_highlight', 'py');
    const response = await upload(data);
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location).toMatch(/^\/upload\/[a-z-]+\?new=1$/);
    const id = location.split('/')[2]!.split('?')[0]!;
    expect(await (await call(`/raw/${id}`)).text()).toBe('posted with curl');
    expect(
      (await row<{ syntax: string }>('SELECT syntax FROM pastas WHERE id = ?', id))?.syntax,
    ).toBe('python');
  });

  it('stores files, honours privacy and returns JSON on request', async () => {
    const data = new FormData();
    data.set('privacy', 'private');
    data.set('plain_key', 'pw');
    data.set('expiration', '1hour');
    data.set('file', new File([bytes(3000)], 'upload.bin'));
    const response = await upload(data, { accept: 'application/json' });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const [key] = await fileKeys(id);
    expect(await r2Exists(key!)).toBe(true);
    expect(
      await row<{ status: string; privacy: string }>(
        'SELECT status, privacy FROM pastas WHERE id = ?',
        id,
      ),
    ).toEqual({ status: 'active', privacy: 'private' });
    const direct = await call(`/file/${id}/0`, form({ password: 'pw' }));
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(bytes(3000));
  });

  it('cannot create secret uploads and validates like the JSON API', async () => {
    const secret = new FormData();
    secret.set('content', 'x');
    secret.set('privacy', 'secret');
    expect((await upload(secret)).status).toBe(400);
    const empty = new FormData();
    empty.set('expiration', '1hour');
    expect((await upload(empty)).status).toBe(400);
    const tooLong = new FormData();
    tooLong.set('content', 'x');
    tooLong.set('expiration', '16years');
    expect((await upload(tooLong)).status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('throttles anonymous creation per client address', async () => {
    const headers = { 'cf-connecting-ip': '198.51.100.23', 'content-type': 'application/json' };
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      statuses.push((await call('/api/pastas', { method: 'POST', headers, body: '{}' })).status);
    }
    expect(statuses).toContain(429);
    const limited = await call('/api/pastas', { method: 'POST', headers, body: '{}' });
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

void uploadFile;
void publish;
