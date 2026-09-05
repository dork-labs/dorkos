import { defineConfig } from 'vitest/config';

/**
 * The plugin's own vitest project.
 *
 * Separate from `vite.config.ts` deliberately: that file is a `lib` build with
 * Obsidian, Electron and every CodeMirror package externalised, plus four
 * bundle-rewriting plugins. Reusing it would drag all of that into a suite whose
 * only job is to read two CSS files and one build output.
 *
 * `node`, not `jsdom` — nothing here mounts a component. The plugin's UI is the
 * client's, and it is tested there.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/` is in on purpose, mirroring apps/desktop/vitest.config.ts:
    // the define gate there decides what ships (a bundle still carrying an
    // unsubstituted build define), and it was code in this package nothing
    // executed.
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    // eslint-disable-next-line no-restricted-syntax -- a vitest config has no env.ts of its own; mirrors packages/relay/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
