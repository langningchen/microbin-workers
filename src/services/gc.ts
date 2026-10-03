import type { Config } from '../config';
import { ackOutbox, deletePastas, selectGarbage, takeOutbox } from '../db/pastas';

type Services = Pick<Env, 'DB' | 'BUCKET'>;

export interface GcReport {
  expired: number;
  stale: number;
  abandoned: number;
  objects: number;
}

/** Unfinished uploads older than this are abandoned (the R2 lifecycle also aborts old multiparts). */
export const PENDING_MAX_AGE_SECONDS = 24 * 3600;

/**
 * Deletes the R2 objects queued on the outbox. Rows are only acknowledged after R2 confirmed the
 * delete, so a failed run is simply retried by the next one.
 */
export async function drainOutbox(env: Services, maxRounds = 3): Promise<number> {
  let removed = 0;
  for (let round = 0; round < maxRounds; round++) {
    const batch = await takeOutbox(env.DB, 500);
    if (batch.length === 0) break;
    for (const item of batch) {
      if (!item.upload_id) continue;
      try {
        await env.BUCKET.resumeMultipartUpload(item.r2_key, item.upload_id).abort();
      } catch {
        // already completed or aborted: the plain delete below handles leftovers
      }
    }
    const keys = batch.map((item) => item.r2_key);
    await env.BUCKET.delete(keys);
    await ackOutbox(env.DB, keys);
    removed += keys.length;
  }
  return removed;
}

/**
 * Cron job: expired / burned / unread / abandoned pastas, then their objects.
 *
 * The work per run is bounded on purpose: the Workers Free plan allows only 50 D1 queries per
 * invocation, and whatever is left over is simply picked up by the next run (every 30 minutes).
 */
export async function runGarbageCollection(
  env: Services,
  config: Config,
  now: number,
): Promise<GcReport> {
  const report: GcReport = { expired: 0, stale: 0, abandoned: 0, objects: 0 };
  for (let round = 0; round < 3; round++) {
    const garbage = await selectGarbage(env.DB, now, config.gcDays, PENDING_MAX_AGE_SECONDS, 100);
    const ids = [...new Set([...garbage.expired, ...garbage.stale, ...garbage.abandoned])];
    if (ids.length === 0) break;
    await deletePastas(env.DB, ids, now);
    report.expired += garbage.expired.length;
    report.stale += garbage.stale.length;
    report.abandoned += garbage.abandoned.length;
  }
  report.objects = await drainOutbox(env);
  return report;
}
