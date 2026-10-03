/**
 * `POST /upload` accepts the multipart form used by upstream MicroBin, so existing
 * `curl -F content=… -F expiration=…` scripts keep working. The body is buffered by the form
 * parser, so it is capped (bigger files use the chunked JSON API that the web UI speaks).
 */
import { Hono } from 'hono';
import { badRequest } from '../errors';
import { enforceLimit } from '../middleware/ratelimit';
import { assertMayUpload, createPasta, planCreate } from '../services/create';
import { drainOutbox } from '../services/gc';
import { createSchema, parseOrThrow } from '../services/schemas';
import { completeUpload, putFile } from '../services/upload';
import { openToken } from '../lib/tokens';
import { MIB, SYNTAX_VALUES } from '../shared/constants';
import type { AppEnv } from '../types';
import { field, readForm } from './helpers';

export const compatRoutes = new Hono<AppEnv>();

export const COMPAT_MAX_BYTES = 25 * MIB;

/** Upstream used syntect file extensions, this port uses highlight.js language names. */
const SYNTAX_ALIASES: Record<string, string> = {
  sh: 'bash',
  cs: 'csharp',
  pas: 'delphi',
  erl: 'erlang',
  hs: 'haskell',
  html: 'xml',
  kt: 'kotlin',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  sc: 'scala',
  yml: 'yaml',
  toml: 'ini',
  md: 'markdown',
  ps1: 'powershell',
};

function normalizeSyntax(value: string | undefined): string {
  if (!value) return 'none';
  const mapped = SYNTAX_ALIASES[value] ?? value;
  return SYNTAX_VALUES.includes(mapped) ? mapped : 'none';
}

compatRoutes.post('/upload', async (c) => {
  const cfg = c.get('cfg');
  const now = c.get('now');
  await enforceLimit(c.env, 'RL_WRITE', `create:${c.get('ip')}`);
  const form = await readForm(c, COMPAT_MAX_BYTES);

  const privacy = field(form, 'privacy') ?? cfg.defaultPrivacy;
  if (privacy === 'secret') {
    throw badRequest(
      'Secret uploads are encrypted in the browser and cannot be created with a plain form',
    );
  }
  const uploads = [form.file]
    .flat()
    .filter((value): value is File => value instanceof File && value.size > 0);

  const input = parseOrThrow(createSchema, {
    content: field(form, 'content') ?? '',
    expiration: field(form, 'expiration') ?? cfg.defaultExpiry,
    burnAfter: Number(field(form, 'burn_after') ?? cfg.defaultBurnAfter),
    syntax: normalizeSyntax(field(form, 'syntax_highlight') ?? field(form, 'syntax')),
    privacy,
    ...(field(form, 'plain_key') || field(form, 'password')
      ? { password: field(form, 'plain_key') || field(form, 'password') }
      : {}),
    files: uploads.map((file) => ({ name: file.name, size: file.size })),
    ...(field(form, 'uploader_password')
      ? { uploaderPassword: field(form, 'uploader_password') }
      : {}),
  });
  await assertMayUpload(cfg, input.uploaderPassword);
  const created = await createPasta(c.env, cfg, planCreate(cfg, input, now), now);

  if (!created.complete) {
    // Re-use the exact token the browser flow would hold (it may carry the encryption key).
    const token = await openToken(cfg.sessionSecret, 'upload', created.token, now);
    if (!token) throw new Error('freshly issued upload token is invalid');
    for (const [idx, file] of uploads.entries()) {
      await putFile(c.env, cfg, token, created.id, idx, { body: file.stream(), length: file.size });
    }
    await completeUpload(c.env, created.id, now);
  }
  c.executionCtx.waitUntil(drainOutbox(c.env));

  if ((c.req.header('accept') ?? '').includes('application/json')) {
    return c.json({ id: created.id, url: `/upload/${created.id}` }, 201);
  }
  return c.redirect(`/upload/${created.id}?new=1`, 302);
});
