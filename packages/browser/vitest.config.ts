import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'browser',
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['src/**/__tests__/**/*.fixture.test.ts', '**/node_modules/**', '**/dist/**'],
    globals: false,
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
