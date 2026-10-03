import { app } from './app';
import { configFor } from './config';
import { nowSeconds } from './lib/time';
import { runGarbageCollection } from './services/gc';

export default {
  fetch: app.fetch,

  /** Cron Trigger: delete expired / burned / stale uploads and their R2 objects. */
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const report = await runGarbageCollection(env, configFor(env), nowSeconds());
        console.log(
          JSON.stringify({ message: 'garbage collection', cron: controller.cron, ...report }),
        );
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
