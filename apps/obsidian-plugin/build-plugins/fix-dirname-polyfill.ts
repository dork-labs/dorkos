import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

/**
 * Vite's browser-safe rewrite of `import.meta.url` (used because the bundle
 * targets both Node and browser-like hosts): when `document` exists it falls
 * back to `document.baseURI`, which Obsidian's Electron renderer serves as
 * `app://obsidian.md/main.js` — a URL string, but not a `file:` one. Any
 * dependency that feeds this straight into a Node API expecting a real file
 * URL/path (`createRequire()`, `fileURLToPath()`, ...) throws at the moment
 * the polyfill runs. `__filename` is the already-correct, real absolute path
 * in this exact host (Electron renderer with nodeIntegration), so every shape
 * below gets rewritten to derive from it instead.
 */
const POLYFILL_EXPR =
  'typeof document>"u"?require("url").pathToFileURL(__filename).href:_documentCurrentScript&&_documentCurrentScript.tagName.toUpperCase()==="SCRIPT"&&_documentCurrentScript.src||new URL("main.js",document.baseURI).href';

export function fixDirnamePolyfill(): Plugin {
  return {
    name: 'fix-dirname-polyfill',
    writeBundle() {
      const mainPath = path.resolve(__dirname, '../dist/main.js');
      let code = fs.readFileSync(mainPath, 'utf-8');
      let fixes = 0;

      code = code.replace(/const __dirname\$1=[^;]*fileURLToPath[^;]*;/g, () => {
        fixes++;
        return 'const __dirname$1=__dirname;';
      });

      // Shape 1: `url.fileURLToPath(<polyfill>)` — a bare path is exactly
      // what fileURLToPath() would have produced, so drop straight to __filename.
      const fileURLToPathShape = `url.fileURLToPath(${POLYFILL_EXPR})`;
      while (code.includes(fileURLToPathShape)) {
        code = code.replace(fileURLToPathShape, '__filename');
        fixes++;
      }

      // Shape 2 (DOR-270): `createRequire(<polyfill>)` — seen from
      // @anthropic-ai/claude-agent-sdk's sdk.mjs, which does
      // `createRequire(import.meta.url)` at module top level. Unlike
      // fileURLToPath(), createRequire() needs an actual file URL (or an
      // absolute path string) — not a bare path is fine too, but we build a
      // real `file://` URL here to stay correct for any future consumer of
      // this same polyfill shape that does expect a URL, not just a path.
      const createRequireShape = `createRequire(${POLYFILL_EXPR})`;
      while (code.includes(createRequireShape)) {
        code = code.replace(
          createRequireShape,
          "createRequire(require('url').pathToFileURL(__filename).href)"
        );
        fixes++;
      }

      // Shape 3: orphaned `node___filename`/`node___dirname` references.
      // Rollup synthesizes these as its own alias for `path.dirname(fileURLToPath(import.meta.url))`
      // (seen from apps/server/src/lib/resolve-root.ts) in first-party
      // server code, normally paired with a declaration hoisted to the top
      // of the chunk. Because this build forces every chunk into one file
      // (`inlineDynamicImports: true`), that declaration gets dropped while
      // the use-site survives, leaving a reference to nothing — a
      // `ReferenceError` at module-evaluation time, same failure class as
      // the other two shapes. The real, always-defined `__filename`/`__dirname`
      // (this CJS bundle's own, provided by the Electron renderer's Node
      // integration) is exactly what this alias was standing in for.
      code = code.replace(/\bnode___filename\b/g, () => {
        fixes++;
        return '__filename';
      });
      code = code.replace(/\bnode___dirname\b/g, () => {
        fixes++;
        return '__dirname';
      });

      if (fixes > 0) {
        fs.writeFileSync(mainPath, code);
        console.log(`  fix-dirname-polyfill: replaced ${fixes} Vite polyfill(s)`);
      }
    },
  };
}
