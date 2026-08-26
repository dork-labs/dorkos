/**
 * The rewrite that makes Vite's `import.meta.url` polyfill survive Obsidian,
 * as a pure string-to-string function.
 *
 * Its own module, separate from the Vite plugin that calls it, for one reason:
 * the plugin's `writeBundle` reads and writes a fixed path under `dist/`, so
 * nothing about it can be asserted without producing a 60 MB bundle first. The
 * decision this file makes — which call sites get rewritten, and when the build
 * must stop — is the part that has actually been wrong twice, so it is the part
 * that gets tests.
 *
 * ## What breaks without it
 *
 * Vite rewrites `import.meta.url` for a bundle that targets both Node and
 * browser-like hosts. The rewrite falls back to `document.baseURI`, which
 * Obsidian's Electron renderer serves as `app://obsidian.md/main.js` — a URL,
 * but not a `file:` one. Feed that to a Node API expecting a real file URL
 * (`fileURLToPath()`, `createRequire()`, …) and it throws the moment the
 * expression evaluates. At a module's TOP LEVEL that is not a broken feature,
 * it is a plugin that does not load at all.
 *
 * @module obsidian-plugin/build-plugins/rewrite-dirname-polyfill
 */

/**
 * Vite's polyfill, verbatim, as it appears in the minified bundle.
 *
 * Kept as a literal (rather than only as the regex below) because the two
 * targeted shapes rewrite to something tidier than the general rule does, and
 * a literal is the cheapest way to spell them.
 */
const POLYFILL_EXPR =
  'typeof document>"u"?require("url").pathToFileURL(__filename).href:_documentCurrentScript&&_documentCurrentScript.tagName.toUpperCase()==="SCRIPT"&&_documentCurrentScript.src||new URL("main.js",document.baseURI).href';

/** Escape a string for literal use inside a `RegExp`. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The same polyfill as a pattern, with the emitted asset name left open.
 *
 * The bundle is forced into one `main.js` today, so the literal above matches
 * what is actually emitted. This tolerates a renamed entry anyway, because the
 * failure mode of a near-miss is not a worse-looking bundle — it is a plugin
 * that throws before `onload()`.
 */
const POLYFILL_PATTERN = new RegExp(
  escapeForRegExp(POLYFILL_EXPR).replace(
    escapeForRegExp('new URL("main.js",document.baseURI).href'),
    'new URL\\("[^"]*",document\\.baseURI\\)\\.href'
  ),
  'g'
);

/**
 * The distinctive middle of the polyfill, used to detect a VARIANT the rewrite
 * did not recognise.
 *
 * Deliberately not the whole expression: a shape that differs from
 * {@link POLYFILL_PATTERN} by a byte is exactly the case
 * {@link rewriteDirnamePolyfills} must fail on rather than ship. It also cannot
 * collide with Vite's own `var _documentCurrentScript = …` declaration, which
 * survives the rewrite and must not be read as a leftover.
 */
const POLYFILL_SIGNATURE = '_documentCurrentScript&&_documentCurrentScript.tagName';

/** What one rewrite pass did. */
export interface DirnameRewrite {
  /** The rewritten bundle. */
  code: string;
  /** How many substitutions were made, for the build log. */
  fixes: number;
}

/**
 * Thrown when a polyfill site survives the rewrite.
 *
 * The build stops rather than writing the file, because the alternative is a
 * `dist/` that looks finished, installs cleanly, and throws at module-evaluation
 * time inside somebody's vault — the failure this whole module exists to
 * prevent, shipped with a green build behind it.
 */
export class PolyfillSurvivedError extends Error {
  /** How many sites were still there after the rewrite. */
  readonly survivors: number;

  /**
   * @param survivors - Count of unrewritten polyfill sites.
   * @param sample - A slice of the bundle around the first one, for the log.
   */
  constructor(survivors: number, sample: string) {
    super(
      `fix-dirname-polyfill: ${survivors} import.meta.url polyfill site(s) survived the rewrite. ` +
        'Obsidian serves document.baseURI as an app:// URL, so each of these throws when it ' +
        'evaluates — at module top level that means the plugin never loads. Widen the pattern in ' +
        `build-plugins/rewrite-dirname-polyfill.ts to cover this shape:\n…${sample}…`
    );
    this.name = 'PolyfillSurvivedError';
    this.survivors = survivors;
  }
}

/**
 * Rewrite every `import.meta.url` polyfill site in a built bundle.
 *
 * ## Why the general rule is the last one and not the only one
 *
 * The two targeted shapes below produce tidier output — `__filename` reads
 * better than `fileURLToPath(pathToFileURL(__filename).href)`, so that one call
 * is collapsed where it is found. Everything else gets the GENERAL rule: the
 * polyfill EXPRESSION is replaced with the Node branch it already contains. That
 * is correct for every consumer rather than for a list of them — the value
 * becomes the real `file:` URL of the running bundle, which is what
 * `import.meta.url` was supposed to be — so a consumer nobody enumerated
 * (`createRequire()`, `new URL(x, …)`, the next one) is fixed without being
 * named.
 *
 * **Finding sites by the polyfill rather than by the caller is what makes
 * minification survivable, and that is the bug this replaced.** The old rewrite
 * matched the caller by NAME (`url.fileURLToPath(`), and Rollup renames `url` to
 * something like `Qte`. Two sites were surviving on `main` as a result — one of
 * them at top level, in `@dorkos/db`'s migrations-folder module — which is to
 * say the plugin did not load at all.
 *
 * @param code - The built bundle.
 * @returns The rewritten bundle and the substitution count.
 * @throws {PolyfillSurvivedError} When any polyfill site is left afterwards.
 */
export function rewriteDirnamePolyfills(code: string): DirnameRewrite {
  let out = code;
  let fixes = 0;

  out = out.replace(/const __dirname\$1=[^;]*fileURLToPath[^;]*;/g, () => {
    fixes++;
    return 'const __dirname$1=__dirname;';
  });

  const polyfills = rewritePolyfillSites(out);
  out = polyfills.code;
  fixes += polyfills.fixes;

  // Shape 3: orphaned `node___filename`/`node___dirname` references. Rollup
  // synthesizes these as its own alias for
  // `path.dirname(fileURLToPath(import.meta.url))` (seen from
  // apps/server/src/lib/resolve-root.ts) in first-party server code, normally
  // paired with a declaration hoisted to the top of the chunk. Because this
  // build forces every chunk into one file (`inlineDynamicImports: true`), that
  // declaration gets dropped while the use-site survives, leaving a reference to
  // nothing — a `ReferenceError` at module-evaluation time, same failure class
  // as the polyfill itself.
  out = out.replace(/\bnode___filename\b/g, () => {
    fixes++;
    return '__filename';
  });
  out = out.replace(/\bnode___dirname\b/g, () => {
    fixes++;
    return '__dirname';
  });

  assertNoPolyfillSurvived(out);
  return { code: out, fixes };
}

/**
 * The value the polyfill produces on its own Node branch — the real `file:` URL
 * of the running bundle, which is what `import.meta.url` was supposed to be.
 */
const NODE_BRANCH = 'require("url").pathToFileURL(__filename).href';

/**
 * Matches a `fileURLToPath(` call — including a minified namespace in front of
 * it — at the very END of the text preceding a polyfill occurrence.
 *
 * Anchored with `$` and only ever applied to a short tail slice, which is the
 * whole point: the bundle is 60 MB, and a pattern like
 * `(?:[\w$]+\.)*fileURLToPath\(<polyfill>\)` swept across it backtracks its way
 * into a build that never finishes (measured: >7 minutes and still running,
 * against 13 seconds for the whole build). Occurrences are found by the literal
 * polyfill first, and only their immediate surroundings are then examined.
 */
const FILE_URL_TO_PATH_TAIL = /(?:^|[^\w$.])([\w$.]*fileURLToPath)\($/;

/** How far back to look for the callee wrapping a polyfill occurrence. */
const TAIL_WINDOW = 64;

/**
 * Rewrite every polyfill occurrence, collapsing a wrapping `fileURLToPath()`
 * where there is one.
 *
 * @param code - The bundle so far.
 * @returns The rewritten bundle and how many sites were changed.
 */
function rewritePolyfillSites(code: string): DirnameRewrite {
  const pieces: string[] = [];
  let cursor = 0;
  let fixes = 0;

  for (const match of code.matchAll(POLYFILL_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    const tail = code.slice(Math.max(cursor, start - TAIL_WINDOW), start);
    const wrapping = FILE_URL_TO_PATH_TAIL.exec(tail);

    if (wrapping && code[end] === ')') {
      // `<ns.>fileURLToPath(<polyfill>)` — a bare path is exactly what the call
      // would have produced, so the whole call collapses to __filename.
      pieces.push(code.slice(cursor, start - wrapping[1].length - 1), '__filename');
      cursor = end + 1;
    } else {
      // Everything else — `createRequire(…)` (DOR-270), `new URL(x, …)`, or a
      // consumer nobody has enumerated. Fixing the VALUE rather than the call is
      // correct for all of them at once, and needs no list to stay correct.
      pieces.push(code.slice(cursor, start), NODE_BRANCH);
      cursor = end;
    }
    fixes++;
  }

  pieces.push(code.slice(cursor));
  return { code: pieces.join(''), fixes };
}

/**
 * Fail the build if any polyfill site is left.
 *
 * @param code - The rewritten bundle.
 * @throws {PolyfillSurvivedError} When a site survived.
 */
function assertNoPolyfillSurvived(code: string): void {
  const at = code.indexOf(POLYFILL_SIGNATURE);
  if (at === -1) return;
  const survivors = code.split(POLYFILL_SIGNATURE).length - 1;
  throw new PolyfillSurvivedError(survivors, code.slice(Math.max(0, at - 80), at + 160));
}
