import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run outside of per-test-file storage isolation and may run several times;
// applyD1Migrations() only applies migrations that are still missing.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
