import { defineConfig } from '@playwright/test';

const port = Number(process.env.DORKOS_CATALOG_TEST_PORT ?? 6371);

export default defineConfig({
  testDir: './tests',
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: {
    command: `pnpm preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
