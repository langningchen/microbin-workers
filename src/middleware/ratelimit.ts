import { tooManyRequests } from '../errors';
import type { Bindings } from '../types';

/**
 * Applies a Workers Rate Limiting binding. Counters are per Cloudflare location and eventually
 * consistent, which is exactly right for abuse mitigation. The binding is optional so the app also
 * runs where it is not configured.
 */
export async function enforceLimit(
  env: Bindings,
  name: 'RL_WRITE' | 'RL_AUTH',
  key: string,
): Promise<void> {
  const limiter = env[name] as RateLimit | undefined;
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw tooManyRequests();
}
