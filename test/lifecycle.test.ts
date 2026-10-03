import { describe, expect, it } from 'vitest';
import {
  call,
  callWith,
  create,
  fileKeys,
  form,
  json,
  nowSec,
  r2Exists,
  row,
  run,
  runCron,
  bytes,
  uploadFile,
  publish,
} from './helpers';

const readCount = async (id: string) =>
  (await row<{ read_count: number }>('SELECT read_count FROM pastas WHERE id = ?', id))?.read_count;

describe('listing and visibility', () => {
  it('lists public uploads but never unlisted ones', async () => {
    const pub = await create({ content: 'visible in list', privacy: 'public' });
    const unlisted = await create({ content: 'hidden', privacy: 'unlisted' });
    const html = await (await call('/list')).text();
    expect(html).toContain(pub.id);
    expect(html).not.toContain(unlisted.id);
  });

  it('redirects /list home when listing is disabled', async () => {
    const response = await call('/list', {}, { NO_LISTING: true });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
  });

  it('returns 404 for unknown, malformed and weird ids', async () => {
    for (const path of [
      '/upload/does-not-exist',
      '/upload/a',
      '/raw/zzz-zzz',
      '/file/nope/0',
      '/qr/nope',
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
    }
    expect((await call('/upload/..%2f..%2fetc')).status).toBe(404);
  });

  it('generates animal ids by default and short ids with HASH_IDS', async () => {
    const animal = await create({});
    expect(animal.id).toMatch(/^[a-z]+(-[a-z]+){3}$/);
    const hashed = await create({}, { HASH_IDS: true });
    expect(hashed.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
    expect((await call(`/raw/${hashed.id}`)).status).toBe(200);
  });

  it('gives uploads that are protected by their link alone much longer ids', async () => {
    const listed = await create({ privacy: 'public' });
    expect(listed.id.split('-')).toHaveLength(4);
    const unlisted = await create({ privacy: 'unlisted' });
    expect(unlisted.id.split('-')).toHaveLength(8); // 48 bit instead of 24
    const readonly = await create({ privacy: 'readonly', password: 'pw' });
    expect(readonly.id.split('-')).toHaveLength(8);
    const longer = await create({ privacy: 'unlisted' }, { ID_LENGTH: 10 });
    expect(longer.id.split('-')).toHaveLength(10); // the setting can only raise it
    const hashed = await create({ privacy: 'unlisted' }, { HASH_IDS: true });
    expect(hashed.id).toHaveLength(12);
    expect((await call(`/raw/${unlisted.id}`)).status).toBe(200);
  });
});

describe('URL shortener', () => {
  it('turns a lone http(s) URL into a redirect', async () => {
    const created = await create({ content: ' https://example.com/a?b=1 ' });
    for (const prefix of ['url', 'u']) {
      const response = await call(`/${prefix}/${created.id}`);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://example.com/a?b=1');
    }
    const page = await (await call(created.url)).text();
    expect(page).toContain('Follow this short link');
    expect(page).toContain('Copy Redirect');
  });

  it('never redirects to dangerous schemes or non-URL text', async () => {
    for (const content of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'see https://example.com',
      'ftp://example.com/x',
    ]) {
      const created = await create({ content });
      expect((await call(`/u/${created.id}`)).status, content).toBe(404);
    }
  });

  it('does not shorten URLs that are encrypted or have files', async () => {
    const created = await create({
      content: 'https://example.com',
      privacy: 'private',
      password: 'pw',
    });
    expect((await call(`/u/${created.id}`)).status).toBe(404);
  });
});

describe('expiration', () => {
  it('hides expired uploads immediately, before garbage collection runs', async () => {
    const created = await create({ content: 'short lived', expiration: '1min' });
    expect((await call(`/raw/${created.id}`)).status).toBe(200);
    await run('UPDATE pastas SET expires_at = ? WHERE id = ?', nowSec() - 5, created.id);
    expect((await call(`/raw/${created.id}`)).status).toBe(404);
    expect((await call(created.url)).status).toBe(404);
    expect(await (await call('/list')).text()).not.toContain(created.id);
  });

  it('enforces MAX_EXPIRY and ETERNAL_PASTA', async () => {
    const tooLong = await call('/api/pastas', json({ content: 'x', expiration: '1month' }));
    expect(tooLong.status).toBe(400);
    const never = await call('/api/pastas', json({ content: 'x', expiration: 'never' }), {
      MAX_EXPIRY: 'never',
    });
    expect(never.status).toBe(400); // allowed only together with ETERNAL_PASTA
    const ok = await call('/api/pastas', json({ content: 'x', expiration: 'never' }), {
      MAX_EXPIRY: 'never',
      ETERNAL_PASTA: true,
    });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { id: string }).id;
    expect(
      (await row<{ expires_at: number | null }>('SELECT expires_at FROM pastas WHERE id = ?', id))
        ?.expires_at,
    ).toBeNull();
  });

  it('garbage collection removes expired uploads together with their files', async () => {
    const created = await create({ content: 'with file', files: [{ name: 'a.bin', size: 100 }] });
    await uploadFile(created, bytes(100));
    expect((await publish(created)).status).toBe(200);
    const keys = await fileKeys(created.id);
    expect(keys).toHaveLength(1);
    expect(await r2Exists(keys[0]!)).toBe(true);

    await run('UPDATE pastas SET expires_at = ? WHERE id = ?', nowSec() - 5, created.id);
    await runCron();
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).toBeNull();
    expect(await row('SELECT * FROM pasta_files WHERE paste_id = ?', created.id)).toBeNull();
    expect(await r2Exists(keys[0]!)).toBe(false);
    expect(await row('SELECT * FROM r2_gc WHERE r2_key = ?', keys[0])).toBeNull();
  });

  it('garbage collection honours GC_DAYS for uploads nobody reads', async () => {
    const stale = await create({ content: 'forgotten' });
    const fresh = await create({ content: 'recent' });
    await run('UPDATE pastas SET last_read_at = ? WHERE id = ?', nowSec() - 91 * 86400, stale.id);
    await runCron();
    expect(await row('SELECT id FROM pastas WHERE id = ?', stale.id)).toBeNull();
    expect(await row('SELECT id FROM pastas WHERE id = ?', fresh.id)).not.toBeNull();
    // GC_DAYS=0 disables the rule
    const keep = await create({ content: 'kept' });
    await run('UPDATE pastas SET last_read_at = ? WHERE id = ?', nowSec() - 999 * 86400, keep.id);
    await runCron({ GC_DAYS: 0 });
    expect(await row('SELECT id FROM pastas WHERE id = ?', keep.id)).not.toBeNull();
  });

  it('garbage collection discards abandoned unfinished uploads and their parts', async () => {
    const created = await create({ files: [{ name: 'x.bin', size: 50 }] });
    await uploadFile(created, bytes(50)); // uploaded but never published
    const [key] = await fileKeys(created.id);
    expect(await call(created.url).then((r) => r.status)).toBe(404); // pending is invisible
    await run('UPDATE pastas SET created_at = ? WHERE id = ?', nowSec() - 2 * 86400, created.id);
    await runCron();
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).toBeNull();
    expect(await r2Exists(key!)).toBe(false);
  });
});

describe('reading', () => {
  it('counts reads, and not for HEAD or right after creation', async () => {
    const created = await create({});
    expect(await readCount(created.id)).toBe(0);
    await call(`${created.url}?new=1`); // the creator's redirect
    expect(await readCount(created.id)).toBe(0);
    await call(created.url, { method: 'HEAD' });
    expect(await readCount(created.id)).toBe(0);
    await call(created.url);
    await call(`/raw/${created.id}`);
    expect(await readCount(created.id)).toBe(2);
    const html = await (await call(created.url)).text();
    expect(html).toContain('Read 3 times');
  });

  it('only trusts ?new=1 for a short while', async () => {
    const created = await create({});
    await run('UPDATE pastas SET created_at = ? WHERE id = ?', nowSec() - 3600, created.id);
    await call(`${created.url}?new=1`);
    expect(await readCount(created.id)).toBe(1);
  });
});

describe('burn after reads', () => {
  it('never burns on GET: a link preview only sees a confirmation page', async () => {
    const created = await create({ content: 'top secret note', burnAfter: 1 });
    const preview = await call(created.url);
    const html = await preview.text();
    expect(preview.status).toBe(200);
    expect(html).toContain('burns after reading');
    expect(html).not.toContain('top secret note');
    expect(await readCount(created.id)).toBe(0);
  });

  it('shows the share link to the creator and still does not burn', async () => {
    const created = await create({ burnAfter: 1 });
    const html = await (await call(`${created.url}?new=1`)).text();
    expect(html).toContain('Upload created');
    expect(await readCount(created.id)).toBe(0);
  });

  it('reveals once and then the upload is gone', async () => {
    const created = await create({ content: 'read me once', burnAfter: 1 });
    const first = await call(created.url, form({ confirm: '1' }));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('read me once');
    expect((await call(created.url, form({ confirm: '1' }))).status).toBe(404);
    expect((await call(`/raw/${created.id}`)).status).toBe(404);
    expect((await call(created.url)).status).toBe(404);
  });

  it('is atomic: parallel readers cannot both consume the last read', async () => {
    const created = await create({ content: 'race', burnAfter: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => call(created.url, form({ confirm: '1' }))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 404)).toHaveLength(7);
    expect(await readCount(created.id)).toBe(1);
  });

  it('supports N reads and the raw endpoint consumes reads directly', async () => {
    const created = await create({ content: 'three times', burnAfter: 10 });
    await run('UPDATE pastas SET burn_after_reads = 3 WHERE id = ?', created.id);
    for (let i = 0; i < 3; i++) expect((await call(`/raw/${created.id}`)).status).toBe(200);
    expect((await call(`/raw/${created.id}`)).status).toBe(404);
  });

  it('keeps the files reachable only through the page that consumed the read', async () => {
    const created = await create({ burnAfter: 1, files: [{ name: 'report.pdf', size: 64 }] });
    await uploadFile(created, bytes(64));
    await publish(created);

    // direct access (no token) is refused: files cannot dodge the burn counter
    expect((await call(`/file/${created.id}/0`)).status).toBe(403);

    const revealed = await (await call(created.url, form({ confirm: '1' }))).text();
    const link = revealed.match(/href="(\/file\/[^"]+t=[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(link, 'file link with token').toBeTruthy();
    expect((await call(created.url, form({ confirm: '1' }))).status).toBe(404); // burned
    const file = await call(link!);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes(64));
    expect((await call(`/file/${created.id}/0`)).status).toBe(403);
  });
});

describe('editing and removing', () => {
  it('lets anyone edit a public upload and re-detects links', async () => {
    const created = await create({ content: 'first draft' });
    const editor = await (await call(`/edit/${created.id}`)).text();
    expect(editor).toContain('first draft');
    const saved = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'https://example.com/new' }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/upload/${created.id}`);
    expect((await call(`/u/${created.id}`)).headers.get('location')).toBe(
      'https://example.com/new',
    );
  });

  it('validates edits', async () => {
    const created = await create({ content: 'x' });
    const empty = await call(`/edit/${created.id}`, form({ intent: 'save', content: '   ' }));
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain('cannot be empty');
    const huge = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'x'.repeat(2048) }),
      { MAX_TEXT_KB: 1 },
    );
    expect(huge.status).toBe(413);
  });

  it('removing needs a POST (a GET only shows a confirmation) and cleans up files', async () => {
    const created = await create({ content: 'delete me', files: [{ name: 'f.bin', size: 10 }] });
    await uploadFile(created, bytes(10));
    await publish(created);
    const [key] = await fileKeys(created.id);

    const confirm = await call(`/remove/${created.id}`);
    expect(confirm.status).toBe(200);
    expect((await call(`/raw/${created.id}`)).status).toBe(200); // GET did not delete anything

    const removed = await call(`/remove/${created.id}`, { method: 'POST' });
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/list');
    expect((await call(`/raw/${created.id}`)).status).toBe(404);
    expect(await r2Exists(key!)).toBe(false);
  });

  it('refuses to edit or remove uploads created with EDITABLE=false', async () => {
    const created = await create({ content: 'frozen' }, { EDITABLE: false });
    expect((await call(`/edit/${created.id}`)).status).toBe(403);
    expect((await call(`/remove/${created.id}`)).status).toBe(403);
    expect((await call(`/remove/${created.id}`, { method: 'POST' })).status).toBe(403);
    expect((await call(`/raw/${created.id}`)).status).toBe(200);
  });
});

describe('QR codes', () => {
  it('renders an inline SVG for the short link', async () => {
    const created = await create({});
    const html = await (await call(`/qr/${created.id}`)).text();
    expect(html).toContain('<svg');
    expect(html).toContain(`/p/${created.id}`);
    expect((await call(`/qr/${created.id}`, {}, { QR: false })).status).toBe(404);
  });

  it('encodes the redirect link for short URLs', async () => {
    const created = await create({ content: 'https://example.com' });
    expect(
      await (await call(`/qr/${created.id}`, {}, { SHORT_URL: 'https://s.example' })).text(),
    ).toContain(`https://s.example/u/${created.id}`);
  });
});

void callWith;
