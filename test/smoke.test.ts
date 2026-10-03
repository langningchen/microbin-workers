import { describe, expect, it } from 'vitest';
import { call, create, json } from './helpers';

describe('smoke', () => {
  it('serves the create page and the health check', async () => {
    const home = await call('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('pasta-form');
    const health = await call('/healthz');
    expect(await health.json()).toEqual({ ok: true });
  });

  it('creates, views and reads back a text upload', async () => {
    const created = await create({ content: 'Hello <b>MicroBin</b>' });
    expect(created.complete).toBe(true);
    const view = await call(created.url);
    const html = await view.text();
    expect(view.status).toBe(200);
    expect(html).toContain('Hello &lt;b&gt;MicroBin&lt;/b&gt;'); // escaped, never raw HTML
    const raw = await call(`/raw/${created.id}`);
    expect(await raw.text()).toBe('Hello <b>MicroBin</b>');
    expect(raw.headers.get('content-type')).toContain('text/plain');
  });

  it('rejects invalid input with a JSON error', async () => {
    const response = await call('/api/pastas', json({ content: '', expiration: '1hour' }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('empty');
  });
});
