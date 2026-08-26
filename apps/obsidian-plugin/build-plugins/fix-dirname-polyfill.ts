import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';
import { rewriteDirnamePolyfills } from './rewrite-dirname-polyfill.js';

/**
 * Apply {@link rewriteDirnamePolyfills} to the built bundle.
 *
 * All the decisions live in that module, which is pure and therefore testable;
 * this is the file-handling half. It writes unconditionally rather than only
 * when something changed, because a bundle with zero substitutions is a bundle
 * whose polyfill shape moved — and that case now throws out of the rewrite
 * instead of reaching here.
 */
export function fixDirnamePolyfill(): Plugin {
  return {
    name: 'fix-dirname-polyfill',
    writeBundle() {
      const mainPath = path.resolve(__dirname, '../dist/main.js');
      const { code, fixes } = rewriteDirnamePolyfills(fs.readFileSync(mainPath, 'utf-8'));
      if (fixes > 0) {
        fs.writeFileSync(mainPath, code);
        console.log(`  fix-dirname-polyfill: replaced ${fixes} Vite polyfill(s)`);
      }
    },
  };
}
