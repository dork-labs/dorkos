import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve `@dorkos/shared/schemas` to the package's SOURCE, not its built
    // `dist/`. Same reasoning as `apps/server/vitest.config.ts`: the `exports` map
    // points `default` at `dist/`, so under the targeted `pnpm vitest run <path>`
    // loop a stale dist tests yesterday's module — a false PASS, not a loud
    // failure.
    //
    // `src/__tests__/shape-manifest.test.ts` is a DRIFT GUARD, and an unusually
    // load-bearing one: this package's permission-mode list is a hand copy (of
    // the copy `@dorkos/skills` keeps to stay out of the browser bundle), and
    // that test reading `PermissionModeSchema.options` is the only thing holding
    // it to the original. Against a stale dist it compares two yesterdays and
    // agrees — a drift guard that cannot see drift is worse than none.
    alias: [
      {
        find: '@dorkos/shared/schemas',
        replacement: fileURLToPath(new URL('../shared/src/schemas.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
  },
});
