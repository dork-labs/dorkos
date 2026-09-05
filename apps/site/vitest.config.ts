import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
