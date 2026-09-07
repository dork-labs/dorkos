import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The mounted protocol test executes the local server's source directly.
      // Read this self-contained policy module from source as the server suite
      // does, so a fresh site-only test graph does not depend on relay dist.
      '@dorkos/relay/approver-allowlist': path.resolve(
        __dirname,
        '../../packages/relay/src/adapters/approver-allowlist.ts'
      ),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // What `--project <name>` matches from the repo root. Rationale:
    // apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1822).
    name: 'site',
    environment: 'jsdom',
    globals: true,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
