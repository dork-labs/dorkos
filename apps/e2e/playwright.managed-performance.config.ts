import { defineConfig } from '@playwright/test';
import original from './playwright.managed-native.config';
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
export default defineConfig({
  ...original,
  testMatch: 'installed-frame-performance.spec.ts',
  timeout: 300_000,
  use: { ...original.use, connectOptions: { wsEndpoint } },
});
