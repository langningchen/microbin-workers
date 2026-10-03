import { Hono, type Context } from 'hono';
import { deletePastas, findActive, readAndCount } from '../db/pastas';
import { notFound, unauthorized } from '../errors';
import { isValidId } from '../lib/ids';
import { enforceLimit } from '../middleware/ratelimit';
import {
  displayFiles,
  issueFileToken,
  loadReadable,
  readText,
  requirePassword,
} from '../services/access';
import { checkAuthKey } from '../services/credentials';
import { assertMayUpload, createPasta, planCreate } from '../services/create';
import { drainOutbox } from '../services/gc';
import { authorizeRemove } from '../services/modify';
import { completeMultipartSchema, createSchema, parseOrThrow } from '../services/schemas';
import {
  abortUpload,
  completeMultipart,
  completeUpload,
  putFile,
  putPart,
  requireUploadToken,
  startMultipart,
} from '../services/upload';
import type { AppEnv } from '../types';
import { readJson } from './helpers';

export const apiRoutes = new Hono<AppEnv>();

const ID = ':id{[A-Za-z0-9-]{1,200}}';
const IDX = ':idx{[0-9]{1,3}}';

function requireId(id: string): string {
  if (!isValidId(id)) throw notFound();
  return id;
}

/** The `X-Upload-Token` header is checked against the paste in the URL. */
async function uploadSession(c: Context<AppEnv>, id: string) {
  return requireUploadToken(
    c.get('cfg'),
    requireId(id),
    c.req.header('x-upload-token'),
    c.get('now'),
  );
}

function contentLength(c: Context<AppEnv>): number | null {
  const header = c.req.header('content-length');
  return header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
}

// ── creating uploads ──

apiRoutes.post('/api/pastas', async (c) => {
  const cfg = c.get('cfg');
  const now = c.get('now');
  await enforceLimit(c.env, 'RL_WRITE', `create:${c.get('ip')}`);
  const input = parseOrThrow(createSchema, await readJson(c));
  await assertMayUpload(cfg, input.uploaderPassword);
  const created = await createPasta(c.env, cfg, planCreate(cfg, input, now), now);
  return c.json({ ...created, url: `/upload/${created.id}` }, 201);
});

apiRoutes.put(`/api/pastas/${ID}/files/${IDX}`, async (c) => {
  const id = c.req.param('id');
  const token = await uploadSession(c, id);
  const result = await putFile(c.env, c.get('cfg'), token, id, Number(c.req.param('idx')), {
    body: c.req.raw.body,
    length: contentLength(c),
  });
  return c.json(result);
});

apiRoutes.post(`/api/pastas/${ID}/files/${IDX}/multipart`, async (c) => {
  const id = c.req.param('id');
  await uploadSession(c, id);
  return c.json(await startMultipart(c.env, c.get('cfg'), id, Number(c.req.param('idx'))));
});

apiRoutes.put(`/api/pastas/${ID}/files/${IDX}/multipart/:part{[0-9]{1,5}}`, async (c) => {
  const id = c.req.param('id');
  await uploadSession(c, id);
  const part = await putPart(
    c.env,
    c.get('cfg'),
    id,
    Number(c.req.param('idx')),
    Number(c.req.param('part')),
    {
      body: c.req.raw.body,
      length: contentLength(c),
    },
  );
  return c.json(part);
});

apiRoutes.post(`/api/pastas/${ID}/files/${IDX}/multipart/complete`, async (c) => {
  const id = c.req.param('id');
  await uploadSession(c, id);
  const { parts } = parseOrThrow(completeMultipartSchema, await readJson(c));
  return c.json(
    await completeMultipart(c.env, c.get('cfg'), id, Number(c.req.param('idx')), parts),
  );
});

apiRoutes.post(`/api/pastas/${ID}/complete`, async (c) => {
  const id = c.req.param('id');
  await uploadSession(c, id);
  await completeUpload(c.env, id, c.get('now'));
  return c.json({ id, url: `/upload/${id}` });
});

apiRoutes.post(`/api/pastas/${ID}/abort`, async (c) => {
  const id = c.req.param('id');
  await uploadSession(c, id);
  await abortUpload(c.env, id, c.get('now'));
  c.executionCtx.waitUntil(drainOutbox(c.env));
  return c.json({ ok: true });
});

// ── reading / removing through the API ──

/**
 * JSON view of an upload (counts as a read). Secret uploads need `X-Auth-Key` (the key the browser
 * derives from the password) and return ciphertext; private uploads accept `X-Password`.
 */
apiRoutes.get(`/api/pastas/${ID}`, async (c) => {
  const cfg = c.get('cfg');
  const now = c.get('now');
  const id = requireId(c.req.param('id'));
  const pasta = await loadReadable(c.env.DB, id, now);

  let encKey = null;
  if (pasta.privacy === 'secret') {
    // This is the only place where a secret upload's password can be tested online, so every
    // attempt is throttled *before* it is checked (a correct guess must not slip through a limit).
    const authKey = c.req.header('x-auth-key');
    if (!authKey) throw unauthorized('Password required', 'password_required');
    await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
    if (!(await checkAuthKey(pasta, authKey))) {
      throw unauthorized('Incorrect password', 'incorrect_password');
    }
  } else if (pasta.privacy === 'private') {
    await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
    encKey = await requirePassword(pasta, c.req.header('x-password'));
  }

  const opened = await readAndCount(c.env.DB, id, now);
  if (!opened) throw notFound();
  const { pasta: p } = opened;
  const token = await issueFileToken(cfg, p, encKey, now);
  const files = displayFiles(p, opened.files).map((file) => ({
    idx: file.idx,
    name: file.name,
    size: file.size,
    url: `/file/${id}/${file.idx}${token ? `?t=${token}` : ''}`,
  }));
  return c.json(
    {
      id,
      kind: p.kind,
      privacy: p.privacy,
      syntax: p.syntax,
      content: await readText(p, encKey),
      createdAt: p.created_at,
      expiresAt: p.expires_at,
      readCount: p.read_count,
      burnAfterReads: p.burn_after_reads,
      files,
      // lets the browser fetch the (still encrypted) files of a secret upload without the password
      ...(token ? { token } : {}),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

/** Removal for secret uploads (their password can only be checked through the derived key). */
apiRoutes.post(`/api/pastas/${ID}/remove`, async (c) => {
  const id = requireId(c.req.param('id'));
  const pasta = await findActive(c.env.DB, id, c.get('now'));
  if (!pasta) throw notFound();
  await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
  await authorizeRemove(pasta, {
    authKey: c.req.header('x-auth-key'),
    password: c.req.header('x-password'),
    admin: c.get('admin'),
  });
  await deletePastas(c.env.DB, [id], c.get('now'));
  c.executionCtx.waitUntil(drainOutbox(c.env));
  return c.json({ ok: true });
});
