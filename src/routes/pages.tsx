import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { CreatePage } from '../views/create';
import { GuidePage } from '../views/guide';
import { page } from './helpers';

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/', (c) => page(c, <CreatePage cfg={c.get('cfg')} />));
pageRoutes.get('/guide', (c) => page(c, <GuidePage cfg={c.get('cfg')} />));

/** Liveness probe that also proves the database binding works. */
pageRoutes.get('/healthz', async (c) => {
  await c.env.DB.prepare('SELECT 1').first();
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
});
