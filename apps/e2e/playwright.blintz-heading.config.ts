import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const driving = base.projects?.find((project) => project.name === 'chromium-browser-driving');
if (!driving) throw new Error('Missing maintained credential-free browser project');

// Reuse the maintained Vite/server lifecycle and all timing/media defaults.
// Only the fixture-entry spec is collected; no product route or API is mocked.
export default defineConfig({
  ...base,
  testMatch: '**/blintz-heading-selection.spec.ts',
  projects: [
    {
      ...driving,
      name: 'blintz-heading-source',
      testMatch: '**/blintz-heading-selection.spec.ts',
    },
  ],
});
