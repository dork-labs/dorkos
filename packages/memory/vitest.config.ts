import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Resolve the two `@dorkos/shared` subpaths this engine imports at RUNTIME
    // to the package's SOURCE rather than its built `dist/`.
    //
    // This is `test.alias`, NOT `resolve.alias`, on purpose: it applies only
    // under Vitest, so the shipped build keeps resolving the package's `exports`
    // map exactly as it does today. Same wiring, same reason as
    // packages/relay/vitest.config.ts.
    //
    // Without it, the targeted `pnpm vitest run packages/memory` loop AGENTS.md
    // prescribes depends on somebody having built `@dorkos/shared` first — and
    // `memory-provider.ts` is new, so on a fresh checkout its `dist/` entry does
    // not exist at all and every test file fails to import before a single
    // assertion runs. That reads as a broken engine rather than a missing build.
    // The error classes are the load-bearing part: they are runtime values, so
    // `instanceof` must resolve to ONE module instance, and aliasing both
    // subpaths the engine touches is what guarantees it.
    alias: [
      {
        find: '@dorkos/shared/memory-provider',
        replacement: path.resolve(__dirname, '../shared/src/memory-provider.ts'),
      },
      {
        find: '@dorkos/shared/atomic-write',
        replacement: path.resolve(__dirname, '../shared/src/atomic-write.ts'),
      },
    ],
  },
});
