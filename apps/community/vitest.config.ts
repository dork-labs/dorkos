import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'community',
    environment: 'node',
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
