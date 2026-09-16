import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'community-s3-route',
    environment: 'node',
    include: ['src/**/*.s3.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
