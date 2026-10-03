import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toB64Url } from '../src/shared/base64url';
import { ciphertextSize, decryptText, randomBytes } from '../src/shared/crypto';
import {
  bytes,
  call,
  create,
  fileKeys,
  form,
  publish,
  r2Exists,
  row,
  secretFields,
  sha256Hex,
  uploadFile,
} from './helpers';
import { env } from 'cloudflare:workers';

const storedContent = async (id: string) =>
  (await row<{ content: string }>('SELECT content FROM pastas WHERE id = ?', id))?.content ?? '';

describe('private uploads (server-side encryption)', () => {
  it('asks for the password and shows nothing before it is given', async () => {
    const created = await create({
      content: 'classified text',
      privacy: 'private',
      password: 'hunter2',
    });
    const gate = await call(created.url);
    const html = await gate.text();
    expect(gate.status).toBe(200);
    expect(html).toContain('password-field');
    expect(html).not.toContain('classified text');
  });

  it('stores only ciphertext and decrypts with the right password', async () => {
    const created = await create({
      content: 'classified text',
      privacy: 'private',
      password: 'hunter2',
    });
    const stored = await storedContent(created.id);
    expect(stored.startsWith('mbx1.')).toBe(true);
    expect(stored).not.toContain('classified');

    const ok = await call(created.url, form({ password: 'hunter2' }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('classified text');

    const raw = await call(`/raw/${created.id}`, form({ password: 'hunter2' }));
    expect(await raw.text()).toBe('classified text');
  });

  it('rejects wrong passwords without counting a read, and rate limits guessing', async () => {
    const created = await create({ content: 'x', privacy: 'private', password: 'right' });
    const wrong = await call(created.url, form({ password: 'wrong' }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Incorrect password');
    expect(
      (await row<{ read_count: number }>('SELECT read_count FROM pastas WHERE id = ?', created.id))
        ?.read_count,
    ).toBe(0);

    const statuses: number[] = [];
    for (let i = 0; i < 14; i++)
      statuses.push((await call(created.url, form({ password: `guess${i}` }))).status);
    expect(statuses).toContain(429);
  });

  it('encrypts uploaded files on the server and serves them back through a token link', async () => {
    const data = bytes(150_000, 3);
    const created = await create({
      content: 'with attachment',
      privacy: 'private',
      password: 'pw',
      files: [{ name: 'secret.bin', size: data.length }],
    });
    await uploadFile(created, data);
    expect((await publish(created)).status).toBe(200);

    // what R2 holds is not the file
    const [key] = await fileKeys(created.id);
    const object = await env.BUCKET.get(key!);
    const stored = new Uint8Array(await object!.arrayBuffer());
    expect(stored.length).toBe(ciphertextSize(data.length));
    expect(await sha256Hex(stored)).not.toBe(await sha256Hex(data));

    // the page links the file with a token that carries the key
    const html = await (await call(created.url, form({ password: 'pw' }))).text();
    const link = html.match(/href="(\/file\/[^"]+t=[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(link).toBeTruthy();
    const download = await call(link!);
    expect(download.status).toBe(200);
    expect(await sha256Hex(await download.arrayBuffer())).toBe(await sha256Hex(data));

    // without a token you get the password form, and posting the password works too
    const gate = await call(`/file/${created.id}/0`);
    expect(await gate.text()).toContain('password-field');
    const direct = await call(`/file/${created.id}/0`, form({ password: 'pw' }));
    expect(await sha256Hex(await direct.arrayBuffer())).toBe(await sha256Hex(data));
    const wrong = await call(`/file/${created.id}/0`, form({ password: 'nope' }));
    expect(wrong.status).toBe(401);

    // a token for another upload (or a forged one) opens nothing
    const other = await create({ content: 'other', privacy: 'private', password: 'pw2' });
    expect((await call(`/file/${other.id}/0?t=${link!.split('t=')[1]}`)).status).toBe(404);
  });

  it('refuses private files larger than one request can carry', async () => {
    const response = await call('/api/pastas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'x',
        expiration: '1hour',
        privacy: 'private',
        password: 'pw',
        files: [{ name: 'big.bin', size: 70 * 1024 * 1024 }],
      }),
    });
    expect(response.status).toBe(413);
  });

  it('can be edited after unlocking, re-encrypting with the same password', async () => {
    const created = await create({ content: 'original', privacy: 'private', password: 'pw' });
    expect((await call(`/edit/${created.id}`)).status).toBe(200); // password gate
    const unlocked = await call(`/edit/${created.id}`, form({ intent: 'unlock', password: 'pw' }));
    expect(await unlocked.text()).toContain('original');
    const bad = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'hacked', password: 'bad' }),
    );
    expect(bad.status).toBe(401);
    const saved = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'updated text', password: 'pw' }),
    );
    expect(saved.status).toBe(303);
    expect((await storedContent(created.id)).startsWith('mbx1.')).toBe(true);
    expect(await (await call(`/raw/${created.id}`, form({ password: 'pw' }))).text()).toBe(
      'updated text',
    );
  });

  it('is only removable with the password', async () => {
    const created = await create({ content: 'x', privacy: 'private', password: 'pw' });
    const denied = await call(`/remove/${created.id}`, form({ password: 'nope' }));
    expect(denied.status).toBe(401);
    expect((await call(`/remove/${created.id}`, { method: 'POST' })).status).toBe(401);
    const removed = await call(`/remove/${created.id}`, form({ password: 'pw' }));
    expect(removed.status).toBe(303);
    expect(await row('SELECT id FROM pastas WHERE id = ?', created.id)).toBeNull();
  });

  it('zips decrypted files after the password is entered', async () => {
    const a = bytes(1000, 1);
    const b = bytes(2000, 2);
    const created = await create({
      content: 'two files',
      privacy: 'private',
      password: 'pw',
      files: [
        { name: 'a.bin', size: a.length },
        { name: 'b.bin', size: b.length },
      ],
    });
    await uploadFile(created, a, 0);
    await uploadFile(created, b, 1);
    await publish(created);
    const zip = await call(`/archive/${created.id}`, form({ password: 'pw' }));
    expect(zip.status).toBe(200);
    const { parseZip } = await import('./helpers');
    const entries = parseZip(new Uint8Array(await zip.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(['a.bin', 'b.bin']);
    expect(entries[0]!.data).toEqual(a);
    expect(entries[1]!.data).toEqual(b);
  });
});

describe('read-only uploads', () => {
  it('can be read by anyone but only changed with the password', async () => {
    const created = await create({
      content: 'public but protected',
      privacy: 'readonly',
      password: 'edit-me',
    });
    expect(await (await call(`/raw/${created.id}`)).text()).toBe('public but protected');
    expect(await (await call(created.url)).text()).toContain('public but protected');

    const editor = await (await call(`/edit/${created.id}`)).text();
    expect(editor).toContain('Re-enter Password');
    const wrong = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'defaced', password: 'bad' }),
    );
    expect(wrong.status).toBe(401);
    const right = await call(
      `/edit/${created.id}`,
      form({ intent: 'save', content: 'edited', password: 'edit-me' }),
    );
    expect(right.status).toBe(303);
    expect(await (await call(`/raw/${created.id}`)).text()).toBe('edited');

    expect((await call(`/remove/${created.id}`, form({ password: 'bad' }))).status).toBe(401);
    expect((await call(`/remove/${created.id}`, form({ password: 'edit-me' }))).status).toBe(303);
  });

  it('does not list read-only uploads', async () => {
    const created = await create({ content: 'x', privacy: 'readonly', password: 'pw' });
    expect(await (await call('/list')).text()).not.toContain(created.id);
  });
});

describe('secret uploads (client-side encryption)', () => {
  it('never exposes the content, and serves ciphertext only to the key holder', async () => {
    const secret = await secretFields('correct horse', 'the launch code is 0000');
    const created = await create(secret.fields);

    // the page is only a shell
    const html = await (await call(created.url)).text();
    expect(html).toContain('unlock-form');
    expect(html).not.toContain('launch code');
    expect(html).not.toContain(secret.fields.content);
    expect(html).toContain(secret.fields.kdf.salt); // public parameters the browser needs

    const noKey = await call(`/api/pastas/${created.id}`);
    expect(noKey.status).toBe(401);
    const badKey = await call(`/api/pastas/${created.id}`, {
      headers: { 'x-auth-key': 'A'.repeat(43) },
    });
    expect(badKey.status).toBe(401);

    const ok = await call(`/api/pastas/${created.id}`, {
      headers: { 'x-auth-key': secret.authHeader },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { content: string; privacy: string; readCount: number };
    expect(body.privacy).toBe('secret');
    expect(body.readCount).toBe(1);
    expect(await decryptText(secret.key, body.content)).toBe('the launch code is 0000');
  });

  it('refuses plaintext in a secret upload and incomplete parameters', async () => {
    const secret = await secretFields('pw', 'x');
    const plain = await call('/api/pastas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...secret.fields, content: 'not encrypted', expiration: '1hour' }),
    });
    expect(plain.status).toBe(400);
    const noKdf = await call('/api/pastas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        privacy: 'secret',
        content: secret.fields.content,
        expiration: '1hour',
      }),
    });
    expect(noKdf.status).toBe(400);
  });

  it('keeps file bytes and names opaque and serves them only after unlocking', async () => {
    const secret = await secretFields('pw', 'text');
    const ciphertext = bytes(5000, 9); // stands in for what the browser encrypted
    const created = await create({
      ...secret.fields,
      files: [{ name: 'ignored.txt', size: ciphertext.length }],
    });
    await uploadFile(created, ciphertext);
    await publish(created);
    expect(
      (await row<{ name: string }>('SELECT name FROM pasta_files WHERE paste_id = ?', created.id))
        ?.name,
    ).toBe('');

    // no token, and presenting the key to the file route is no longer a way in
    expect((await call(`/file/${created.id}/0`)).status).toBe(401);
    expect(
      (await call(`/file/${created.id}/0`, { headers: { 'x-auth-key': secret.authHeader } }))
        .status,
    ).toBe(401);

    // the throttled unlock endpoint hands out the token
    const unlock = await call(`/api/pastas/${created.id}`, {
      headers: { 'x-auth-key': secret.authHeader },
    });
    const { token, files } = (await unlock.json()) as { token: string; files: { url: string }[] };
    expect(token).toBeTruthy();
    expect(files[0]!.url).toBe(`/file/${created.id}/0?t=${token}`);
    const file = await call(files[0]!.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(ciphertext);

    // a token is bound to its upload
    const other = await create((await secretFields('pw', 'other')).fields);
    expect((await call(`/file/${other.id}/0?t=${token}`)).status).toBe(404);
    expect((await call(`/archive/${created.id}`)).status).toBe(403); // the browser builds this zip
  });

  it('throttles online password guesses before checking them', async () => {
    const secret = await secretFields('the real password', 'guarded');
    const created = await create(secret.fields);
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const wrong = toB64Url(randomBytes(32));
      statuses.push(
        (await call(`/api/pastas/${created.id}`, { headers: { 'x-auth-key': wrong } })).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses).toContain(429);
    // locked out: even the correct key is refused until the window passes
    const late = await call(`/api/pastas/${created.id}`, {
      headers: { 'x-auth-key': secret.authHeader },
    });
    expect(late.status).toBe(429);
  });

  it('can only be removed with the derived key', async () => {
    const secret = await secretFields('pw', 'to be removed');
    const created = await create(secret.fields);
    expect((await call(`/api/pastas/${created.id}/remove`, { method: 'POST' })).status).toBe(401);
    const bad = await call(`/api/pastas/${created.id}/remove`, {
      method: 'POST',
      headers: { 'x-auth-key': 'B'.repeat(43) },
    });
    expect(bad.status).toBe(401);
    const ok = await call(`/api/pastas/${created.id}/remove`, {
      method: 'POST',
      headers: { 'x-auth-key': secret.authHeader },
    });
    expect(ok.status).toBe(200);
    expect(
      (await call(`/api/pastas/${created.id}`, { headers: { 'x-auth-key': secret.authHeader } }))
        .status,
    ).toBe(404);
  });

  it('is not readable as raw text', async () => {
    const secret = await secretFields('pw', 'x');
    const created = await create(secret.fields);
    expect((await call(`/raw/${created.id}`)).status).toBe(403);
  });
});

describe('production PBKDF2 limit', () => {
  // Local workerd accepts any iteration count while Cloudflare production throws
  // NotSupportedError above 100,000. Re-impose the production limit so a regression fails here.
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  beforeEach(() => {
    crypto.subtle.deriveBits = ((
      algorithm: { name: string; iterations?: number },
      ...rest: unknown[]
    ) => {
      if (algorithm.name === 'PBKDF2' && (algorithm.iterations ?? 0) > 100_000) {
        throw new DOMException(
          `Pbkdf2 failed: iteration counts above 100000 are not supported (requested ${algorithm.iterations}).`,
          'NotSupportedError',
        );
      }
      return (original as (...args: unknown[]) => Promise<ArrayBuffer>)(algorithm, ...rest);
    }) as typeof crypto.subtle.deriveBits;
  });
  afterEach(() => {
    crypto.subtle.deriveBits = original;
  });

  it('never asks Web Crypto for more than 100,000 iterations', async () => {
    const created = await create({ content: 'x', privacy: 'private', password: 'pw' });
    expect((await call(created.url, form({ password: 'pw' }))).status).toBe(200);
    const ro = await create({ content: 'x', privacy: 'readonly', password: 'pw' });
    expect((await call(`/remove/${ro.id}`, form({ password: 'pw' }))).status).toBe(303);
  });

  it('clamps an over-ambitious PBKDF2_ITERATIONS setting instead of failing in production', async () => {
    const created = await create(
      { content: 'x', privacy: 'private', password: 'pw' },
      { PBKDF2_ITERATIONS: 600_000 },
    );
    expect(
      (await row<{ kdf_iter: number }>('SELECT kdf_iter FROM pastas WHERE id = ?', created.id))
        ?.kdf_iter,
    ).toBe(100_000);
    expect((await call(created.url, form({ password: 'pw' }))).status).toBe(200);
  });
});

void r2Exists;
