// Bindings that only exist in tests (see vitest.config.ts).
interface D1Migration {
  name: string;
  queries: string[];
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_PASSWORD?: string;
  }
}
