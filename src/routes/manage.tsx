import { Hono, type Context } from 'hono';
import { deletePastas, findActive, listFiles, listPublic, setContent } from '../db/pastas';
import { HttpError, forbidden, notFound } from '../errors';
import { utf8Length } from '../lib/bytes';
import { isValidId } from '../lib/ids';
import { parseShortenableUrl } from '../lib/url';
import { enforceLimit } from '../middleware/ratelimit';
import { loadReadable, readText, requirePassword } from '../services/access';
import { drainOutbox } from '../services/gc';
import {
  authorizeEdit,
  authorizeRemove,
  canEditText,
  removeNeedsPassword,
} from '../services/modify';
import { editSchema, parseOrThrow } from '../services/schemas';
import { encryptText, importAesKey } from '../shared/crypto';
import type { PasteBoot } from '../shared/boot';
import type { AppEnv } from '../types';
import { EditPage, ListPage, RemovePage } from '../views/manage';
import { UnlockPage } from '../views/paste';
import { field, page, readForm } from './helpers';

export const manageRoutes = new Hono<AppEnv>();

const ID = ':id{[A-Za-z0-9-]{1,200}}';
const PAGE_SIZE = 50;

export function pageNumber(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : 1;
}

function requireId(id: string): string {
  if (!isValidId(id)) throw notFound();
  return id;
}

// ── /list ──

manageRoutes.get('/list', async (c) => {
  const cfg = c.get('cfg');
  if (cfg.noListing) return c.redirect('/');
  const current = pageNumber(c.req.query('page'));
  const rows = await listPublic(c.env.DB, c.get('now'), PAGE_SIZE + 1, (current - 1) * PAGE_SIZE);
  return page(
    c,
    <ListPage
      cfg={cfg}
      items={rows.slice(0, PAGE_SIZE)}
      page={current}
      hasMore={rows.length > PAGE_SIZE}
    />,
  );
});

// ── /edit/:id ──

async function showEditor(c: Context<AppEnv>, id: string) {
  const cfg = c.get('cfg');
  const pasta = await loadReadable(c.env.DB, requireId(id), c.get('now'));
  if (!canEditText(pasta)) throw forbidden('This upload cannot be edited', 'not_editable');
  if (pasta.privacy === 'private') {
    return page(c, <UnlockPage cfg={cfg} action={`/edit/${id}`} hidden={{ intent: 'unlock' }} />);
  }
  return page(
    c,
    <EditPage
      cfg={cfg}
      id={id}
      content={pasta.content}
      needsPassword={pasta.privacy === 'readonly'}
    />,
  );
}

manageRoutes.get(`/edit/${ID}`, (c) => showEditor(c, c.req.param('id')));

manageRoutes.post(`/edit/${ID}`, async (c) => {
  const cfg = c.get('cfg');
  const now = c.get('now');
  const id = requireId(c.req.param('id'));
  const pasta = await loadReadable(c.env.DB, id, now);
  const form = await readForm(c);
  const password = field(form, 'password');
  if (password !== undefined) await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);

  // Step 1 for private uploads: decrypt the text so it can be edited.
  if (field(form, 'intent') === 'unlock') {
    if (!canEditText(pasta)) throw forbidden('This upload cannot be edited', 'not_editable');
    try {
      const key = await requirePassword(pasta, password);
      return page(
        c,
        <EditPage cfg={cfg} id={id} content={await readText(pasta, key)} needsPassword />,
      );
    } catch (error) {
      if (error instanceof HttpError && error.code === 'incorrect_password') {
        return page(
          c,
          <UnlockPage
            cfg={cfg}
            action={`/edit/${id}`}
            hidden={{ intent: 'unlock' }}
            error="Incorrect password."
          />,
          401,
        );
      }
      throw error;
    }
  }

  const { content } = parseOrThrow(editSchema, { content: field(form, 'content') ?? '', password });
  const needsPassword = pasta.privacy === 'readonly' || pasta.privacy === 'private';
  const fail = (message: string, status: 400 | 401 | 413) =>
    page(
      c,
      <EditPage
        cfg={cfg}
        id={id}
        content={content}
        needsPassword={needsPassword}
        error={message}
      />,
      status,
    );

  let grant;
  try {
    grant = await authorizeEdit(pasta, { password });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'incorrect_password') {
      return fail('Incorrect password.', 401);
    }
    throw error;
  }
  if (utf8Length(content) > cfg.maxTextBytes) {
    return fail(`Text is larger than ${Math.floor(cfg.maxTextBytes / 1024)} KiB.`, 413);
  }
  const files = await listFiles(c.env.DB, id);
  if (content.trim() === '' && files.length === 0) return fail('The content cannot be empty.', 400);

  const plain = pasta.privacy !== 'private';
  const kind = plain && files.length === 0 && parseShortenableUrl(content) ? 'url' : 'text';
  const stored =
    !plain && grant.encKey && content !== ''
      ? await encryptText(await importAesKey(grant.encKey), content)
      : plain && kind === 'url'
        ? content.trim()
        : content;
  await setContent(c.env.DB, id, stored, kind, utf8Length(stored));
  return c.redirect(`/upload/${id}`, 303);
});

// ── /remove/:id ──

function removeProof(pasta: { privacy: string }, admin: boolean): 'none' | 'password' | 'secret' {
  if (admin || !removeNeedsPassword(pasta as never)) return 'none';
  return pasta.privacy === 'secret' ? 'secret' : 'password';
}

manageRoutes.get(`/remove/${ID}`, async (c) => {
  const cfg = c.get('cfg');
  const id = requireId(c.req.param('id'));
  const pasta = await findActive(c.env.DB, id, c.get('now'));
  if (!pasta) throw notFound();
  const admin = c.get('admin');
  if (pasta.editable !== 1 && !admin) {
    throw forbidden('This upload can only be removed by an administrator', 'not_editable');
  }
  const proof = removeProof(pasta, admin);
  const boot: PasteBoot | undefined =
    proof === 'secret' && pasta.kdf_salt && pasta.kdf_iter
      ? {
          id,
          mode: 'secret',
          syntax: 'none',
          shortUrl: cfg.shortUrl,
          view: cfg.defaultView,
          secret: { salt: pasta.kdf_salt, iter: pasta.kdf_iter, files: [], canRemove: true },
        }
      : undefined;
  return page(
    c,
    <RemovePage cfg={cfg} id={id} proof={proof} admin={admin} {...(boot ? { boot } : {})} />,
  );
});

manageRoutes.post(`/remove/${ID}`, async (c) => {
  const cfg = c.get('cfg');
  const id = requireId(c.req.param('id'));
  const pasta = await findActive(c.env.DB, id, c.get('now'));
  if (!pasta) throw notFound();
  const form = await readForm(c);
  const password = field(form, 'password');
  const admin = c.get('admin');
  if (password !== undefined) await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
  try {
    await authorizeRemove(pasta, { password, admin });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'incorrect_password') {
      return page(
        c,
        <RemovePage
          cfg={cfg}
          id={id}
          proof={removeProof(pasta, admin)}
          admin={admin}
          error="Incorrect password."
        />,
        401,
      );
    }
    throw error;
  }
  await deletePastas(c.env.DB, [id], c.get('now'));
  c.executionCtx.waitUntil(drainOutbox(c.env));
  return c.redirect(cfg.noListing ? '/' : '/list', 303);
});
