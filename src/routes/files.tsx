import { Hono, type Context } from 'hono';
import { makeZip } from 'client-zip';
import { findActive, listFiles, type FileRow, type PastaRow } from '../db/pastas';
import { HttpError, forbidden, notFound, unauthorized } from '../errors';
import { isValidId } from '../lib/ids';
import { parseRange } from '../lib/range';
import { contentDisposition, isInlineSafe, mimeFor, uniqueNames } from '../lib/mime';
import { enforceLimit } from '../middleware/ratelimit';
import { readFileToken, requirePassword } from '../services/access';
import { fromB64Url } from '../shared/base64url';
import { decryptStream, importAesKey, plaintextSize, type Bytes } from '../shared/crypto';
import type { AppEnv } from '../types';
import { UnlockPage } from '../views/paste';
import { field, page, readForm } from './helpers';

export const fileRoutes = new Hono<AppEnv>();

const ID = ':id{[A-Za-z0-9-]{1,200}}';

/** What a visitor may do with the files of a paste, decided once per request. */
type Access =
  { kind: 'open' } | { kind: 'decrypt'; key: Bytes } | { kind: 'ciphertext' } | { kind: 'unlock' };

async function resolveAccess(
  c: Context<AppEnv>,
  pasta: PastaRow,
  password: string | undefined,
): Promise<Access> {
  const cfg = c.get('cfg');
  const token = await readFileToken(cfg, c.req.query('t'), pasta.id, c.get('now'));

  if (pasta.privacy === 'secret') {
    // Only ciphertext is served, and only to someone who unlocked the upload (the token comes
    // from the throttled unlock endpoint), so this route is not a password oracle.
    if (!token) throw unauthorized('Unlock the upload first', 'token_required');
    return { kind: 'ciphertext' };
  }

  if (pasta.privacy === 'private') {
    const fromToken = token?.k ? fromB64Url(token.k) : null;
    if (fromToken) return { kind: 'decrypt', key: fromToken };
    if (password === undefined) return { kind: 'unlock' };
    await enforceLimit(c.env, 'RL_AUTH', `pw:${pasta.id}`);
    return { kind: 'decrypt', key: await requirePassword(pasta, password) };
  }

  // Burn-after-reads files are only reachable from a page view that consumed a read.
  if (pasta.burn_after_reads > 0 && !token) {
    throw forbidden(
      'Open the upload page first: its files are available for the reader only',
      'token_required',
    );
  }
  return { kind: 'open' };
}

const FILE_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

function fileHeaders(file: FileRow, inline: boolean, volatile: boolean): Headers {
  const safe = isInlineSafe(file.name);
  const headers = new Headers({
    'Content-Type': safe ? mimeFor(file.name) : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline && safe ? 'inline' : 'attachment', file.name),
    // Uploaded files live on our origin: make browsers treat them as inert documents.
    'Content-Security-Policy': FILE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': volatile ? 'private, no-store' : 'private, no-cache',
    'Accept-Ranges': 'bytes',
  });
  return headers;
}

async function serveFile(
  c: Context<AppEnv>,
  rawId: string,
  rawIdx: string | undefined,
  password: string | undefined,
): Promise<Response> {
  if (!isValidId(rawId)) throw notFound();
  const idx = rawIdx === undefined ? 0 : Number(rawIdx);
  const pasta = await findActive(c.env.DB, rawId, c.get('now'));
  if (!pasta || pasta.status !== 'active') throw notFound();
  const file = (await listFiles(c.env.DB, rawId)).find((candidate) => candidate.idx === idx);
  if (!file?.uploaded) throw notFound('File not found');

  const access = await resolveAccess(c, pasta, password).catch((error: unknown) => {
    if (
      error instanceof HttpError &&
      error.code === 'incorrect_password' &&
      password !== undefined
    ) {
      return 'wrong' as const;
    }
    throw error;
  });
  const action = `/file/${rawId}/${idx}`;
  if (access === 'wrong') {
    return page(
      c,
      <UnlockPage cfg={c.get('cfg')} action={action} error="Incorrect password." />,
      401,
    );
  }
  if (access.kind === 'unlock') return page(c, <UnlockPage cfg={c.get('cfg')} action={action} />);

  const preview = c.req.query('preview') === 'true';
  const volatile = pasta.burn_after_reads > 0 || pasta.privacy !== 'public';

  if (access.kind === 'open') {
    // R2 would silently ignore bad ranges, so decide 200 / 206 / 416 here (file.size is trusted:
    // it is the size R2 reported when the upload finished).
    const range = parseRange(c.req.header('range'), file.size);
    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${file.size}` },
      });
    }
    const object = await c.env.BUCKET.get(file.r2_key, {
      onlyIf: c.req.raw.headers, // If-None-Match / If-Modified-Since ...
      ...(range.kind === 'range'
        ? { range: { offset: range.start, length: range.end - range.start + 1 } }
        : {}),
    });
    if (!object) throw notFound('File not found');
    const headers = fileHeaders(file, preview, volatile);
    headers.set('ETag', object.httpEtag);
    if (!('body' in object)) return new Response(null, { status: 304, headers });

    if (range.kind === 'range') {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  // Encrypted files are streamed through in full.
  const object = await c.env.BUCKET.get(file.r2_key);
  if (!object) throw notFound('File not found');
  const headers = fileHeaders(file, preview, true);
  headers.delete('Accept-Ranges');

  if (access.kind === 'ciphertext') {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  const decrypted = object.body.pipeThrough(decryptStream(await importAesKey(access.key)));
  const size = plaintextSize(object.size);
  if (size === null) return new Response(decrypted, { headers });
  // A fixed length makes the runtime send Content-Length and fail loudly if decryption breaks.
  const fixed = new FixedLengthStream(size);
  c.executionCtx.waitUntil(decrypted.pipeTo(fixed.writable).catch(() => undefined));
  return new Response(fixed.readable, { headers });
}

for (const pattern of [`/file/${ID}`, `/file/${ID}/:idx{[0-9]{1,3}}`]) {
  const params = (c: Context<AppEnv>) => c.req.param() as Record<string, string | undefined>;
  fileRoutes.get(pattern, (c) => serveFile(c, params(c).id ?? '', params(c).idx, undefined));
  fileRoutes.post(pattern, async (c) => {
    const form = await readForm(c);
    return serveFile(c, params(c).id ?? '', params(c).idx, field(form, 'password') ?? '');
  });
}

// ── /archive/:id: every file in one streamed ZIP ──

async function serveArchive(c: Context<AppEnv>, rawId: string, password: string | undefined) {
  if (!isValidId(rawId)) throw notFound();
  const pasta = await findActive(c.env.DB, rawId, c.get('now'));
  if (!pasta || pasta.status !== 'active') throw notFound();
  if (pasta.privacy === 'secret') {
    throw forbidden('Secret uploads are encrypted in your browser: use the page to download them');
  }
  const files = (await listFiles(c.env.DB, rawId)).filter((file) => file.uploaded === 1);
  if (files.length === 0) throw notFound('This upload has no files');

  const access = await resolveAccess(c, pasta, password).catch((error: unknown) => {
    if (
      error instanceof HttpError &&
      error.code === 'incorrect_password' &&
      password !== undefined
    ) {
      return 'wrong' as const;
    }
    throw error;
  });
  const action = `/archive/${rawId}`;
  if (access === 'wrong') {
    return page(
      c,
      <UnlockPage cfg={c.get('cfg')} action={action} error="Incorrect password." />,
      401,
    );
  }
  if (access.kind === 'unlock') return page(c, <UnlockPage cfg={c.get('cfg')} action={action} />);

  const key = access.kind === 'decrypt' ? await importAesKey(access.key) : null;
  const names = uniqueNames(files.map((file) => file.name));
  const modified = new Date(pasta.created_at * 1000);

  async function* entries() {
    for (const [i, file] of files.entries()) {
      const object = await c.env.BUCKET.get(file.r2_key);
      if (!object) continue;
      yield {
        name: names[i] ?? file.name,
        lastModified: modified,
        input: key ? object.body.pipeThrough(decryptStream(key)) : object.body,
      };
    }
  }

  return new Response(makeZip(entries()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `${rawId}.zip`),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

fileRoutes.get(`/archive/${ID}`, (c) => serveArchive(c, c.req.param('id'), undefined));
fileRoutes.post(`/archive/${ID}`, async (c) => {
  const form = await readForm(c);
  return serveArchive(c, c.req.param('id'), field(form, 'password') ?? '');
});
