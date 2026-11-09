// Scratch: PR shots for the extension rows. Not committed.
import { devices } from '@playwright/test';
import base from './playwright.config';

const MOCK_VITE_PORT = process.env.DORKOS_MOCK_VITE_PORT ?? '4248';

export default {
  ...base,
  testDir: './.shots-scratch',
  projects: [
    {
      name: 'shots',
      testDir: './.shots-scratch',
      testMatch: ['**/*.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${MOCK_VITE_PORT}` },
    },
  ],
};
