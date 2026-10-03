import { Hono } from 'hono';
import { deletePastas, listAll, stats } from '../db/pastas';
import { notFound } from '../errors';
import { isValidId } from '../lib/ids';
import { safeEqual } from '../lib/safe-equal';
import { endAdminSession, requireAdmin, startAdminSession } from '../middleware/auth';
import { enforceLimit } from '../middleware/ratelimit';
import { drainOutbox, runGarbageCollection } from '../services/gc';
import type { AppEnv } from '../types';
import { AdminLoginPage, AdminPage } from '../views/admin';
import { field, page, readForm } from './helpers';
import { pageNumber } from './manage';

export const adminRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 50;

adminRoutes.get('/admin/login', (c) => {
  const cfg = c.get('cfg');
  if (!cfg.admin) throw notFound('Page not found');
  if (c.get('admin')) return c.redirect('/admin');
  return page(c, <AdminLoginPage cfg={cfg} />);
});

adminRoutes.post('/admin/login', async (c) => {
  const cfg = c.get('cfg');
  if (!cfg.admin) throw notFound('Page not found');
  await enforceLimit(c.env, 'RL_AUTH', `admin:${c.get('ip')}`);
  const form = await readForm(c, 16 * 1024);
  const [userOk, passOk] = await Promise.all([
    safeEqual(field(form, 'username') ?? '', cfg.admin.username),
    safeEqual(field(form, 'password') ?? '', cfg.admin.password),
  ]);
  if (!userOk || !passOk) {
    return page(
      c,
      <AdminLoginPage
        cfg={cfg}
        error="Incorrect username or password."
        username={field(form, 'username')}
      />,
      401,
    );
  }
  await startAdminSession(c);
  return c.redirect('/admin', 303);
});

adminRoutes.post('/admin/logout', (c) => {
  endAdminSession(c);
  return c.redirect('/', 303);
});

const MESSAGES: Record<string, (n: number) => string> = {
  removed: () => 'Upload removed.',
  cleanup: (n) => `Cleanup finished: ${n} uploads and expired files removed.`,
};

adminRoutes.get('/admin', requireAdmin, async (c) => {
  const cfg = c.get('cfg');
  const now = c.get('now');
  const current = pageNumber(c.req.query('page'));
  const [rows, summary] = await Promise.all([
    listAll(c.env.DB, PAGE_SIZE + 1, (current - 1) * PAGE_SIZE),
    stats(c.env.DB, now),
  ]);
  const done = c.req.query('done') ?? '';
  const count = Math.min(1_000_000, Number(c.req.query('n')) || 0);
  return page(
    c,
    <AdminPage
      cfg={cfg}
      items={rows.slice(0, PAGE_SIZE)}
      page={current}
      hasMore={rows.length > PAGE_SIZE}
      now={now}
      stats={summary}
      message={MESSAGES[done]?.(count)}
    />,
  );
});

adminRoutes.post('/admin/remove/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  if (!isValidId(id)) throw notFound();
  await deletePastas(c.env.DB, [id], c.get('now'));
  c.executionCtx.waitUntil(drainOutbox(c.env));
  return c.redirect('/admin?done=removed', 303);
});

adminRoutes.post('/admin/cleanup', requireAdmin, async (c) => {
  const report = await runGarbageCollection(c.env, c.get('cfg'), c.get('now'));
  return c.redirect(
    `/admin?done=cleanup&n=${report.expired + report.stale + report.abandoned}`,
    303,
  );
});
