import { Hono, type Context } from 'hono';
import { renderSVG } from 'uqr';
import { findActive, listFiles, readAndCount, type FileRow, type PastaRow } from '../db/pastas';
import { HttpError, notFound } from '../errors';
import { enforceLimit } from '../middleware/ratelimit';
import { isValidId } from '../lib/ids';
import { parseShortenableUrl } from '../lib/url';
import {
  displayFiles,
  issueFileToken,
  loadReadable,
  readText,
  requirePassword,
} from '../services/access';
import { canEditText } from '../services/modify';
import type { Bytes } from '../shared/crypto';
import type { AppEnv } from '../types';
import { ConfirmPage, PastePage, UnlockPage, type PastaView } from '../views/paste';
import { QrPage } from '../views/manage';
import { field, page, readForm } from './helpers';

export const viewRoutes = new Hono<AppEnv>();

const ID = ':id{[A-Za-z0-9-]{1,200}}';
/** The creator is redirected here right after publishing: that view must not count as a read. */
const FRESH_SECONDS = 120;

function requireId(id: string): string {
  if (!isValidId(id)) throw notFound();
  return id;
}

function toView(
  pasta: PastaRow,
  files: FileRow[],
  content: string,
  token: string | undefined,
): PastaView {
  return {
    id: pasta.id,
    kind: pasta.kind,
    privacy: pasta.privacy,
    syntax: pasta.syntax,
    editable: pasta.editable === 1,
    canEdit: canEditText(pasta),
    content,
    createdAt: pasta.created_at,
    expiresAt: pasta.expires_at,
    readCount: pasta.read_count,
    lastReadAt: pasta.last_read_at,
    burnAfterReads: pasta.burn_after_reads,
    files: displayFiles(pasta, files),
    token,
    ...(pasta.privacy === 'secret' && pasta.kdf_salt && pasta.kdf_iter
      ? { secret: { salt: pasta.kdf_salt, iter: pasta.kdf_iter } }
      : {}),
  };
}

// ── /upload/:id (alias /p/:id) ──

async function show(
  c: Context<AppEnv>,
  id: string,
  form: { password?: string | undefined; confirm?: boolean },
): Promise<Response> {
  const { cfg, now } = { cfg: c.get('cfg'), now: c.get('now') };
  const db = c.env.DB;
  const pasta = await loadReadable(db, requireId(id), now);
  const action = `/upload/${id}`;
  const head = c.req.raw.method === 'HEAD';

  // Secret uploads are decrypted in the browser: serve the shell, count the read on unlock.
  if (pasta.privacy === 'secret') {
    const files = await listFiles(db, id);
    return page(
      c,
      <PastePage cfg={cfg} view={toView(pasta, files, '', undefined)} mode="secret" now={now} />,
    );
  }

  let encKey: Bytes | null = null;
  if (pasta.privacy === 'private') {
    if (form.password === undefined) {
      return page(c, <UnlockPage cfg={cfg} action={action} />);
    }
    await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
    try {
      encKey = await requirePassword(pasta, form.password);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'incorrect_password') {
        return page(c, <UnlockPage cfg={cfg} action={action} error="Incorrect password." />, 401);
      }
      throw error;
    }
  } else if (pasta.burn_after_reads > 0 && !form.confirm) {
    // Chat apps and crawlers prefetch links with GET: never burn on a GET.
    const fresh = c.req.query('new') === '1' && now - pasta.created_at < FRESH_SECONDS;
    return page(
      c,
      <ConfirmPage
        cfg={cfg}
        id={id}
        remaining={pasta.burn_after_reads - pasta.read_count}
        fresh={fresh}
      />,
    );
  }

  const fresh =
    pasta.burn_after_reads === 0 &&
    c.req.query('new') === '1' &&
    now - pasta.created_at < FRESH_SECONDS;
  if (head || fresh) {
    const files = await listFiles(db, id);
    const text = await readText(pasta, encKey);
    const token = await issueFileToken(cfg, pasta, encKey, now);
    return page(
      c,
      <PastePage
        cfg={cfg}
        view={toView(pasta, files, text, token)}
        mode={encKey ? 'private' : 'plain'}
        now={now}
      />,
    );
  }

  const opened = await readAndCount(db, id, now);
  if (!opened) throw notFound();
  const text = await readText(opened.pasta, encKey);
  const token = await issueFileToken(cfg, opened.pasta, encKey, now);
  return page(
    c,
    <PastePage
      cfg={cfg}
      view={toView(opened.pasta, opened.files, text, token)}
      mode={encKey ? 'private' : 'plain'}
      now={now}
    />,
  );
}

for (const prefix of ['upload', 'p']) {
  viewRoutes.get(`/${prefix}/${ID}`, (c) => show(c, c.req.param('id'), {}));
  viewRoutes.post(`/${prefix}/${ID}`, async (c) => {
    const form = await readForm(c);
    return show(c, c.req.param('id'), {
      password: field(form, 'password'),
      confirm: field(form, 'confirm') === '1',
    });
  });
}

// ── /raw/:id ──

async function raw(c: Context<AppEnv>, id: string, password: string | undefined) {
  const { cfg, now } = { cfg: c.get('cfg'), now: c.get('now') };
  const db = c.env.DB;
  const pasta = await loadReadable(db, requireId(id), now);
  const plainText = (text: string, status = 200) =>
    new Response(text, {
      status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });

  if (pasta.privacy === 'secret') {
    return plainText(
      'This upload is encrypted in your browser. Open its page and enter the key.\n',
      403,
    );
  }
  let encKey: Bytes | null = null;
  if (pasta.privacy === 'private') {
    if (password === undefined) return page(c, <UnlockPage cfg={cfg} action={`/raw/${id}`} />);
    await enforceLimit(c.env, 'RL_AUTH', `pw:${id}`);
    try {
      encKey = await requirePassword(pasta, password);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'incorrect_password') {
        return page(
          c,
          <UnlockPage cfg={cfg} action={`/raw/${id}`} error="Incorrect password." />,
          401,
        );
      }
      throw error;
    }
  }
  if (c.req.raw.method === 'HEAD') return plainText('');
  const opened = await readAndCount(db, id, now);
  if (!opened) throw notFound();
  return plainText(await readText(opened.pasta, encKey));
}

viewRoutes.get(`/raw/${ID}`, (c) => raw(c, c.req.param('id'), undefined));
viewRoutes.post(`/raw/${ID}`, async (c) => {
  const form = await readForm(c);
  return raw(c, c.req.param('id'), field(form, 'password') ?? '');
});

// ── /url/:id (alias /u/:id): short link redirect ──

async function redirect(c: Context<AppEnv>, id: string) {
  const now = c.get('now');
  const pasta = await loadReadable(c.env.DB, requireId(id), now);
  if (pasta.kind !== 'url') throw notFound('This upload is not a URL redirect');
  let content = pasta.content;
  if (c.req.raw.method !== 'HEAD') {
    const opened = await readAndCount(c.env.DB, id, now);
    if (!opened) throw notFound();
    content = opened.pasta.content;
  }
  const target = parseShortenableUrl(content);
  if (!target) throw notFound('This upload is not a URL redirect');
  // 302, not 301: browsers must keep asking so reads are counted and deleted links stop working.
  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

viewRoutes.get(`/url/${ID}`, (c) => redirect(c, c.req.param('id')));
viewRoutes.get(`/u/${ID}`, (c) => redirect(c, c.req.param('id')));

// ── /qr/:id ──

viewRoutes.get(`/qr/${ID}`, async (c) => {
  const cfg = c.get('cfg');
  if (!cfg.qr) throw notFound('QR codes are disabled');
  const id = requireId(c.req.param('id'));
  const pasta = await findActive(c.env.DB, id, c.get('now'));
  if (!pasta) throw notFound();
  const base = cfg.shortUrl || c.get('origin');
  const url = `${base}/${pasta.kind === 'url' ? 'u' : 'p'}/${id}`;
  const svg = renderSVG(url, { ecc: 'M', border: 2 });
  return page(c, <QrPage cfg={cfg} id={id} svg={svg} url={url} />);
});
