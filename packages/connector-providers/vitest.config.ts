import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'connector-providers',
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
