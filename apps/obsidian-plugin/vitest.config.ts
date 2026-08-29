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
  },
});
