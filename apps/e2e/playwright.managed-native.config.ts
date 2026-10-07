import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const baseURL = process.env.DORKOS_MANAGED_UI_BASE_URL;
const storageState = process.env.DORKOS_MANAGED_UI_STORAGE_STATE;
const outputDir = process.env.DORKOS_MANAGED_UI_OUTPUT;
const wsEndpoint = process.env.DORKOS_MANAGED_FRONTEND_WS;
if (!wsEndpoint) throw new Error('Parent-owned original frontend WebSocket endpoint required');
const endpoint = new URL(wsEndpoint);
if (
  endpoint.protocol !== 'ws:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password
)
  throw new Error('Parent-owned original local frontend WebSocket endpoint required');
if (!baseURL || !storageState || !outputDir)
  throw new Error(
    'Explicit owned installed-CLI origin, owner authentication state and fresh output directory are required'
  );
const origin = new URL(baseURL);
if (
  origin.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw new Error('Only the explicit owned local installed-CLI origin is accepted');
if (!isAbsolute(storageState) || !isAbsolute(outputDir) || !existsSync(storageState))
  throw new Error('Absolute owner authentication and exclusive output paths are required');
// The original parent must qualify output absence before entry. Worker config deserialization
// can occur after Playwright creates output directories, so absence cannot be checked here.
if (process.env.DORKOS_TEST_RUNTIME === 'true')
  throw new Error('This test requires the actual installed production runtime');
export default defineConfig({
  testDir: './tests/managed-browser',
  testMatch: 'installed-native-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  outputDir,
  reporter: [['list']],
  use: {
    baseURL,
    storageState,
    connectOptions: { wsEndpoint },
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // No webServer: the parent retains the original CLI installation, process, logs and shutdown.
});
