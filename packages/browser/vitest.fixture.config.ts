import { defineConfig } from 'vitest/config';

/** Explicit existing-binary fixture acceptance, separate from portable default tests. */
export default defineConfig({
  test: {
    name: 'browser-fixture',
    environment: 'node',
    include: ['src/**/__tests__/**/*.fixture.test.ts'],
    globals: false,
    retry: 0,
    fileParallelism: false,
  },
});
