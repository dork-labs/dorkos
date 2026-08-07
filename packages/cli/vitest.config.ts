import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve `@dorkos/shared/config-schema` to the package's SOURCE, not its
    // built `dist/`. Same reasoning as `apps/server/vitest.config.ts`: the
    // `exports` map points `default` at `dist/`, so under the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes, a stale dist tests
    // yesterday's module — a false PASS, not a loud failure.
    //
    // `src/__tests__/log-level.test.ts` is a DRIFT GUARD: it pins every entry of
    // `LOG_LEVEL_MAP` to its numeric value, because the CLI hands that number to
    // the server through `DORKOS_LOG_LEVEL` and a renumbering would silently
    // change what `--log-level warn` means. Read from a stale dist it pins the
    // old numbers and reports success.
    alias: [
      {
        find: '@dorkos/shared/config-schema',
        replacement: fileURLToPath(new URL('../shared/src/config-schema.ts', import.meta.url)),
      },
      // Same reasoning for `MAX_CAPABILITY_LIMIT`, which the CLI's catalog pager
      // and the server's `limit` ceiling both read from one place: read from a
      // stale dist, a test pinning the request URL pins yesterday's page size.
      {
        find: '@dorkos/shared/capabilities',
        replacement: fileURLToPath(new URL('../shared/src/capabilities.ts', import.meta.url)),
      },
    ],
  },
  test: {
    globals: false,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
