import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;
const STATE = '.wrangler/e2e-state';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // A real `wrangler dev` (workerd, local D1 + R2) with its own throw-away state.
  webServer: {
    command:
      `pnpm dlx wrangler d1 migrations apply DB --local --persist-to ${STATE} && ` +
      `pnpm dlx wrangler dev --port ${PORT} --persist-to ${STATE} ` +
      `--var SESSION_SECRET:e2e-session-secret-0123456789abcdef0123456789 ` +
      `--var ADMIN_PASSWORD:admin-pass ` +
      // small thresholds: a 12 MB file already exercises the multipart code path
      `--var UPLOAD_SINGLE_MAX_MB:5 --var UPLOAD_PART_MB:5`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
