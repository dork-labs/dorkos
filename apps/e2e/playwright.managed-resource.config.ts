import { defineConfig } from '@playwright/test';
import original from './playwright.managed-native.config';
/** Separate resource window: no latency, RTT, stalled-viewer or provider campaign. */
export default defineConfig({
  ...original,
  testMatch: 'installed-resource-window.spec.ts',
});
