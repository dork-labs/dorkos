import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

/**
 * Put `manifest.json` beside the bundle, which is what makes the output a
 * loadable Obsidian plugin rather than a stray `main.js`.
 *
 * **It does nothing when there is no bundle, and that is not defensiveness.**
 * Rollup runs `closeBundle` on a FAILED build too, so copying unconditionally
 * threw `ENOENT` on the missing `dist/` and that error replaced the real one on
 * its way out — every broken build reported a missing manifest instead of
 * whatever actually broke. Skipping here lets the real failure through.
 */
export function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const root = path.resolve(__dirname, '..');
      const outDir = path.resolve(root, 'dist');
      if (!fs.existsSync(outDir)) return;
      fs.copyFileSync(path.resolve(root, 'manifest.json'), path.resolve(outDir, 'manifest.json'));
    },
  };
}
