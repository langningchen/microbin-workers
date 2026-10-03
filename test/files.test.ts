import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIB } from '../src/shared/constants';
import {
  bytes,
  call,
  create,
  fileKeys,
  json,
  parseZip,
  publish,
  r2Exists,
  row,
  runCron,
  sha256Hex,
  uploadFile,
  type Created,
} from './helpers';

const token = (created: Created) => ({ 'x-upload-token': created.token ?? '' });

async function publicFile(name: string, data: Uint8Array, fields: Record<string, unknown> = {}) {
  const created = await create({ files: [{ name, size: data.length }], ...fields });
  await uploadFile(created, data);
  expect((await publish(created)).status).toBe(200);
  return created;
}

describe('uploading a single file', () => {
  it('keeps an upload invisible until it is published', async () => {
    const data = bytes(2048);
    const created = await create({ content: 'hi', files: [{ name: 'a.bin', size: data.length }] });
    expect(created.complete).toBe(false);
    expect(created.files).toEqual([{ idx: 0, mode: 'single' }]);
    expect((await call(created.url)).status).toBe(404);
    expect((await call(`/raw/${created.id}`)).status).toBe(404);
    expect((await publish(created)).status).toBe(409); // file missing
    await uploadFile(created, data);
    expect((await publish(created)).status).toBe(200);
    expect((await call(created.url)).status).toBe(200);
    expect((await publish(created)).status).toBe(409); // already published
  });

  it('checks the upload token and the announced size', async () => {
    const data = bytes(100);
    const created = await create({ files: [{ name: 'a.bin', size: data.length }] });
    const other = await create({ files: [{ name: 'b.bin', size: 1 }] });
    const put = (headers: Record<string, string>, body: Uint8Array = data) =>
      call(`/api/pastas/${created.id}/files/0`, {
        method: 'PUT',
        headers: { 'content-length': String(body.length), ...headers },
        body,
      });

    expect((await put({})).status).toBe(401);
    expect((await put({ 'x-upload-token': 'garbage' })).status).toBe(401);
    expect((await put(token(other))).status).toBe(403); // token of another upload
    expect((await put(token(created), bytes(99))).status).toBe(400);
    expect((await put(token(created), bytes(101))).status).toBe(400);
    expect((await put(token(created))).status).toBe(200);
    expect((await put(token(created))).status).toBe(409); // no overwriting
    const missing = await call(`/api/pastas/${created.id}/files/3`, {
      method: 'PUT',
      headers: { ...token(created), 'content-length': '1' },
      body: new Uint8Array(1),
    });
    expect(missing.status).toBe(404);
  });

  it('serves the bytes with safe headers', async () => {
    const data = bytes(5000, 4);
    const created = await publicFile('Holiday Photo.png', data);
    const response = await call(`/file/${created.id}/0`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get('content-length')).toBe('5000');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Holiday Photo.png"/,
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    // the bare /file/:id URL means "first file"
    expect((await call(`/file/${created.id}`)).status).toBe(200);
  });

  it('shows images inline only on request, and never active content', async () => {
    const png = await publicFile('pic.png', bytes(64));
    const inline = await call(`/file/${png.id}/0?preview=true`);
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/);
    expect(inline.headers.get('content-type')).toBe('image/png');

    for (const name of ['evil.html', 'evil.js', 'page.xhtml', 'x.exe']) {
      const bad = await publicFile(name, bytes(64));
      const response = await call(`/file/${bad.id}/0?preview=true`);
      expect(response.headers.get('content-disposition'), name).toMatch(/^attachment/);
      expect(response.headers.get('content-type'), name).toBe('application/octet-stream');
    }
  });

  it('supports conditional and range requests (video seeking, resumable downloads)', async () => {
    const data = bytes(1000, 7);
    const created = await publicFile('movie.mp4', data);
    const first = await call(`/file/${created.id}/0`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const notModified = await call(`/file/${created.id}/0`, { headers: { 'if-none-match': etag } });
    expect(notModified.status).toBe(304);

    const part = await call(`/file/${created.id}/0`, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(part.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.slice(10, 20));

    const tail = await call(`/file/${created.id}/0`, { headers: { range: 'bytes=-5' } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(data.slice(995));

    const open = await call(`/file/${created.id}/0`, { headers: { range: 'bytes=990-' } });
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(data.slice(990));

    expect(
      (await call(`/file/${created.id}/0`, { headers: { range: 'bytes=5000-6000' } })).status,
    ).toBe(416);
  });

  it('handles empty files and unicode names', async () => {
    const empty = await publicFile('empty.txt', new Uint8Array(0));
    const file = await call(`/file/${empty.id}/0`);
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(0);

    const unicode = await publicFile('报告 final ✓.txt', bytes(10));
    const response = await call(`/file/${unicode.id}/0`);
    expect(response.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''%E6%8A%A5%E5%91%8A",
    );
  });

  it('sanitises file names: no paths, bidi tricks or control characters', async () => {
    const created = await create({
      files: [
        { name: '../../etc/passwd', size: 1 },
        { name: 'photo\u202Egnp.exe', size: 1 },
        { name: 'C:\\Users\\me\\a<b>.txt', size: 1 },
      ],
    });
    const { results } = await env.DB.prepare(
      'SELECT name FROM pasta_files WHERE paste_id = ? ORDER BY idx',
    )
      .bind(created.id)
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['passwd', 'photognp.exe', 'ab.txt']);
  });

  it('renders file names safely in the page', async () => {
    const created = await publicFile('<img src=x onerror=alert(1)>.txt', bytes(5));
    const html = await (await call(created.url)).text();
    expect(html).not.toContain('<img src=x onerror');
  });
});

describe('uploading several files', () => {
  it('offers gallery/list views and a streamed ZIP with unique names', async () => {
    const a = bytes(300, 1);
    const b = bytes(70_000, 2);
    const c = bytes(5, 3);
    const created = await create({
      content: 'bundle',
      files: [
        { name: 'same.txt', size: a.length },
        { name: 'same.txt', size: b.length },
        { name: 'c.bin', size: c.length },
      ],
    });
    await uploadFile(created, a, 0);
    await uploadFile(created, b, 1);
    await uploadFile(created, c, 2);
    expect((await publish(created)).status).toBe(200);

    const html = await (await call(created.url)).text();
    expect(html).toContain('view-selector');
    expect(html).toContain('Download all as ZIP');
    expect(html).toContain('list-view');

    const zip = await call(`/archive/${created.id}`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toContain(`${created.id}.zip`);
    const entries = parseZip(new Uint8Array(await zip.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(['same.txt', 'same (2).txt', 'c.bin']);
    expect(entries[0]!.data).toEqual(a);
    expect(entries[1]!.data).toEqual(b);
    expect(entries[2]!.data).toEqual(c);
  });

  it('limits file count, size and the NO_FILE_UPLOAD switch', async () => {
    const two = [
      { name: 'a', size: 1 },
      { name: 'b', size: 1 },
    ];
    const post = (files: unknown[], overrides = {}) =>
      call('/api/pastas', json({ content: 'x', expiration: '1hour', files }), overrides);
    expect((await post(two, { MAX_FILES: 1 })).status).toBe(400);
    expect(
      (await post([{ name: 'big', size: 2 * MIB }], { MAX_FILE_SIZE_UNENCRYPTED_MB: 1 })).status,
    ).toBe(413);
    expect((await post(two, { NO_FILE_UPLOAD: true })).status).toBe(400);
    expect((await post(two)).status).toBe(201);
  });
});

describe('multipart uploads for big files', () => {
  // R2 needs 5 MiB parts; shrink the thresholds so the test stays small.
  const limits = { UPLOAD_SINGLE_MAX_MB: 5, UPLOAD_PART_MB: 5 };
  const size = 11 * MIB + 123;

  it('assembles parts into the original file', async () => {
    const data = bytes(size, 5);
    const created = await create({ files: [{ name: 'big.bin', size }] }, limits);
    expect(created.files).toEqual([{ idx: 0, mode: 'multipart' }]);
    const base = `/api/pastas/${created.id}/files/0/multipart`;
    const headers = token(created);

    const started = await call(base, { method: 'POST', headers }, limits);
    expect(started.status).toBe(200);
    const info = (await started.json()) as { uploadId: string; partSize: number; parts: number };
    expect(info.parts).toBe(3);
    expect(info.partSize).toBe(5 * MIB);
    const again = (await (
      await call(base, { method: 'POST', headers }, limits)
    ).json()) as typeof info;
    expect(again.uploadId).toBe(info.uploadId); // idempotent for retries

    const put = (n: number, body: Uint8Array) =>
      call(
        `${base}/${n}`,
        { method: 'PUT', headers: { ...headers, 'content-length': String(body.length) }, body },
        limits,
      );
    expect((await put(1, data.slice(0, 5 * MIB - 1))).status).toBe(400); // wrong size
    expect((await put(4, data.slice(0, 10))).status).toBe(400); // no such part
    const etags: { partNumber: number; etag: string }[] = [];
    for (let n = 1; n <= 3; n++) {
      const response = await put(n, data.slice((n - 1) * 5 * MIB, Math.min(size, n * 5 * MIB)));
      expect(response.status).toBe(200);
      etags.push((await response.json()) as { partNumber: number; etag: string });
    }

    const complete = (parts: unknown) =>
      call(
        `${base}/complete`,
        { ...json({ parts }), headers: { ...headers, 'content-type': 'application/json' } },
        limits,
      );
    expect((await complete(etags.slice(0, 2))).status).toBe(400); // a part is missing
    expect((await complete(etags)).status).toBe(200);
    expect((await publish(created)).status).toBe(200);

    const file = await call(`/file/${created.id}/0`);
    expect(file.headers.get('content-length')).toBe(String(size));
    expect(await sha256Hex(await file.arrayBuffer())).toBe(await sha256Hex(data));
    const middle = await call(`/file/${created.id}/0`, {
      headers: { range: `bytes=${5 * MIB - 5}-${5 * MIB + 4}` },
    });
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(
      data.slice(5 * MIB - 5, 5 * MIB + 5),
    );
  });

  it('does not allow multipart for small or private files', async () => {
    const small = await create({ files: [{ name: 's.bin', size: 100 }] }, limits);
    const response = await call(
      `/api/pastas/${small.id}/files/0/multipart`,
      { method: 'POST', headers: token(small) },
      limits,
    );
    expect(response.status).toBe(400);
  });

  it('abandoned multipart uploads are aborted and their objects removed by cleanup', async () => {
    const created = await create({ files: [{ name: 'big.bin', size }] }, limits);
    const base = `/api/pastas/${created.id}/files/0/multipart`;
    await call(base, { method: 'POST', headers: token(created) }, limits);
    const aborted = await call(`/api/pastas/${created.id}/abort`, {
      method: 'POST',
      headers: token(created),
    });
    expect(aborted.status).toBe(200);
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).toBeNull();
    await runCron();
    expect(await row('SELECT * FROM r2_gc')).toBeNull();
  });
});

describe('cleaning up', () => {
  it('aborting an upload removes the paste and every uploaded object', async () => {
    const created = await create({ files: [{ name: 'a.bin', size: 10 }] });
    await uploadFile(created, bytes(10));
    const [key] = await fileKeys(created.id);
    expect(await r2Exists(key!)).toBe(true);
    const aborted = await call(`/api/pastas/${created.id}/abort`, {
      method: 'POST',
      headers: token(created),
    });
    expect(aborted.status).toBe(200);
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).toBeNull();
    expect(await r2Exists(key!)).toBe(false);
  });

  it('publishing restarts the expiry clock', async () => {
    const created = await create({ expiration: '1hour', files: [{ name: 'a.bin', size: 4 }] });
    await env.DB.prepare(
      'UPDATE pastas SET created_at = created_at - 1800, expires_at = expires_at - 1800 WHERE id = ?',
    )
      .bind(created.id)
      .run();
    const before = await row<{ expires_at: number }>(
      'SELECT expires_at FROM pastas WHERE id = ?',
      created.id,
    );
    await uploadFile(created, bytes(4));
    await publish(created);
    const after = await row<{ expires_at: number; created_at: number }>(
      'SELECT expires_at, created_at FROM pastas WHERE id = ?',
      created.id,
    );
    // 30 minutes were "spent" uploading, the full hour is granted again
    expect(after!.expires_at - after!.created_at).toBe(3600);
    expect(after!.expires_at).toBeGreaterThan(before!.expires_at + 1700);
  });
});
