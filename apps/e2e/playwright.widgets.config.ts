import { defineConfig } from '@playwright/test';

/** Local-only widget gallery proof; Vite renders fake host ports without a server. */
export default defineConfig({
  testDir: './tests/gen-ui',
  testMatch: 'channel-widgets.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://localhost:6268', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'pnpm --filter @dorkos/client exec vite --host 127.0.0.1 --port 6268 --strictPort',
    cwd: '../..',
    url: 'http://localhost:6268/dev/gen-ui',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
