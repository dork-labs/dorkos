import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'community-s3-route',
    environment: 'node',
    // The space server's code lives in the DorkOS server package (server-merge step 7).
    dir: '../server/src/services/spaces',
    include: ['**/*.s3.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
