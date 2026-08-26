/**
 * The `import.meta.url` rewrite has to survive minification, and the build has
 * to stop when it does not (DOR-1563).
 *
 * **Every fixture below is a real shape taken out of a real bundle**, not an
 * invented one. `Qte.fileURLToPath(` is what Rollup renamed
 * `url.fileURLToPath(` to in `dist/main.js` on `main` — and because the old
 * rewrite matched the caller by the literal name `url.`, that site survived, at
 * module top level, inside `@dorkos/db`'s migrations-folder module. A top-level
 * site does not break a feature: it throws before `onload()` runs, so the plugin
 * does not load at all.
 *
 * @module obsidian-plugin/__tests__/rewrite-dirname-polyfill
 */
import { describe, it, expect } from 'vitest';
import {
  rewriteDirnamePolyfills,
  PolyfillSurvivedError,
} from '../../build-plugins/rewrite-dirname-polyfill.js';

/** Vite's polyfill exactly as it is emitted into the minified bundle. */
const POLYFILL =
  'typeof document>"u"?require("url").pathToFileURL(__filename).href:_documentCurrentScript&&_documentCurrentScript.tagName.toUpperCase()==="SCRIPT"&&_documentCurrentScript.src||new URL("main.js",document.baseURI).href';

describe('the shapes the rewrite has to catch', () => {
  it('rewrites a fileURLToPath call whose namespace Rollup renamed', () => {
    // The exact survivor from `main`: `@dorkos/db`'s MIGRATIONS_FOLDER, at the
    // top level of the bundle, with `url` minified to `Qte`.
    const { code, fixes } = rewriteDirnamePolyfills(
      `path$2.join(path$2.dirname(Qte.fileURLToPath(${POLYFILL})),"../drizzle");`
    );

    expect(code).toBe('path$2.join(path$2.dirname(__filename),"../drizzle");');
    expect(fixes).toBe(1);
  });

  it('rewrites the same call when the namespace was NOT renamed', () => {
    const { code } = rewriteDirnamePolyfills(`const x=url.fileURLToPath(${POLYFILL});`);

    expect(code).toBe('const x=__filename;');
  });

  it('rewrites a bare fileURLToPath call', () => {
    const { code } = rewriteDirnamePolyfills(`const x=fileURLToPath(${POLYFILL});`);

    expect(code).toBe('const x=__filename;');
  });

  it('leaves a renamed createRequire callee alone and fixes only its argument', () => {
    // DOR-270's shape, reached through a minified namespace. The callee is not
    // touched — rewriting it to a bare `createRequire` would emit a reference to
    // nothing, a ReferenceError in place of the URL error. `createRequire` wants
    // a file URL rather than a bare path, and that is exactly what the polyfill's
    // own Node branch produces.
    const { code } = rewriteDirnamePolyfills(`const r=Ab$3.createRequire(${POLYFILL});`);

    expect(code).toBe('const r=Ab$3.createRequire(require("url").pathToFileURL(__filename).href);');
  });

  it('rewrites a consumer it has never seen, by fixing the value rather than the call', () => {
    // The general rule. `new URL(x, import.meta.url)` is not a shape anybody
    // enumerated, and it does not need to be: what the polyfill produces is
    // wrong, so the polyfill is what gets replaced.
    const { code } = rewriteDirnamePolyfills(`const u=new URL("./drizzle",${POLYFILL});`);

    expect(code).toBe(
      'const u=new URL("./drizzle",require("url").pathToFileURL(__filename).href);'
    );
  });

  it('tolerates an entry file named something other than main.js', () => {
    const renamed = POLYFILL.replace('new URL("main.js"', 'new URL("plugin.js"');

    const { code } = rewriteDirnamePolyfills(`const x=Qte.fileURLToPath(${renamed});`);

    expect(code).toBe('const x=__filename;');
  });

  it('still rewrites the __dirname alias and the orphaned Rollup aliases', () => {
    const { code, fixes } = rewriteDirnamePolyfills(
      `const __dirname$1=path.dirname(url.fileURLToPath(import.meta.url));` +
        `const a=node___filename,b=node___dirname;`
    );

    expect(code).toBe('const __dirname$1=__dirname;const a=__filename,b=__dirname;');
    expect(fixes).toBe(3);
  });
});

describe('the size of the thing it runs on', () => {
  it('rewrites a bundle-sized string in well under a second', { timeout: 5_000 }, () => {
    // `dist/main.js` is ~60 MB. The first cut of this rewrite used
    // `(?:[\w$]+\.)*fileURLToPath\(<polyfill>\)` as one sweep across the whole
    // file and backtracked into a build that had not finished after seven
    // minutes. That is not a slow test, it is a broken build, and nothing else
    // in the suite would have noticed — so the size is asserted here.
    const filler = 'x'.repeat(1_000_000);
    const big = `${filler}Qte.fileURLToPath(${POLYFILL});${filler}${filler}`;

    const started = Date.now();
    const { code, fixes } = rewriteDirnamePolyfills(big);

    expect(fixes).toBe(1);
    expect(code).toContain('__filename;');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('what the build does when a site survives', () => {
  it('throws rather than writing a bundle that will not load', () => {
    // A polyfill VARIANT: same shape, one byte different (`>"u"` spelled out).
    // This is the case the assertion exists for — a rewrite that silently
    // matched nothing used to ship a dist/ that installs cleanly and throws
    // inside somebody's vault.
    const variant = POLYFILL.replace('typeof document>"u"', 'typeof document==="undefined"');

    expect(() => rewriteDirnamePolyfills(`const x=Qte.fileURLToPath(${variant});`)).toThrow(
      PolyfillSurvivedError
    );
  });

  it('says how many sites survived and shows one of them', () => {
    const variant = POLYFILL.replace('typeof document>"u"', 'typeof document==="undefined"');

    let thrown: PolyfillSurvivedError | undefined;
    try {
      rewriteDirnamePolyfills(`a(${variant});b(${variant});`);
    } catch (err) {
      thrown = err as PolyfillSurvivedError;
    }

    expect(thrown?.survivors).toBe(2);
    expect(thrown?.message).toContain('_documentCurrentScript');
  });

  it("does not mistake Vite's own _documentCurrentScript declaration for a leftover", () => {
    // Vite emits this once at the top of every bundle and it must survive. An
    // assertion keyed on the identifier alone would fail every build.
    const declaration =
      'var _documentCurrentScript=typeof document<"u"?document.currentScript:null;';

    expect(() => rewriteDirnamePolyfills(declaration)).not.toThrow();
  });
});
