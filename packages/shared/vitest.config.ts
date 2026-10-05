import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // The connector schema modules live in `@dork-labs/connector-providers`,
        // whose `exports` point at its built `dist/`. Without this alias every
        // test here that reaches them (directly or through this package's
        // re-exports) runs yesterday's compiled copy: a mutation in that
        // package's `src/` with `dist/` left stale passed this package's whole
        // connector-schemas suite. Only the flat schema subpaths are mapped;
        // shared never imports the Composio adapter.
        find: /^@dork-labs\/connector-providers\/(connector-[a-z-]+|stable-stringify)$/,
        replacement: fileURLToPath(new URL('../connector-providers/src/$1.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // What `--project <name>` matches from the repo root. Rationale:
    // apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1822).
    name: 'shared',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
