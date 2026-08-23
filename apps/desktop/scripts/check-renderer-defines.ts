/**
 * Refuse to ship a renderer bundle that still carries an unsubstituted build
 * define.
 *
 * **The failure this exists for shipped.** The desktop renderer is the CLIENT's
 * source built by a SECOND config (`electron.vite.config.ts`), and that config
 * carried no `define` block. A bundler does not warn about a `define` it was
 * never given — the identifier simply survives into the output — and TypeScript
 * is happy because `apps/client/src/vite-env.d.ts` declares it as a global. So
 * v0.63.0 packaged green, passed every test, and threw `ReferenceError:
 * __APP_VERSION__ is not defined` at module scope before React mounted: a
 * permanently black window on every desktop install (DOR-1448).
 *
 * Nothing else was in a position to notice. Unit tests run against source, where
 * Vitest supplies the global; the packaged smoke test boots the app but does not
 * read the renderer; and the symptom is invisible until an installer is in
 * someone's hands. The emitted bundle is the only artifact that carries the
 * evidence, so it is what gets read — after `electron-vite build`, before
 * anything is packaged.
 *
 * The declared globals are parsed from `vite-env.d.ts` rather than listed here:
 * that file is what makes an unsubstituted identifier compile, so it is exactly
 * the list that must be checked. A new one is covered the day it is declared.
 *
 * @module scripts/check-renderer-defines
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_PKG = path.resolve(HERE, '..');

/** The emitted renderer, exactly as electron-builder will package it. */
const RENDERER_DIR = path.resolve(DESKTOP_PKG, 'dist/renderer');

/** Where the client declares the globals its bundlers are expected to substitute. */
const CLIENT_GLOBALS_DTS = path.resolve(DESKTOP_PKG, '../client/src/vite-env.d.ts');

/**
 * The build-time globals the client declares.
 *
 * @param dtsSource - Contents of `apps/client/src/vite-env.d.ts`.
 * @returns Every `__NAME__` global declared there, de-duplicated.
 * @throws If the file declares none — a check with an empty list passes forever
 *   and would hide the next rename of that file's contents.
 */
export function parseInjectedGlobals(dtsSource: string): string[] {
  const names = [...dtsSource.matchAll(/\bconst\s+(__[A-Z0-9_]+__)\b/g)].map((match) => match[1]);
  if (names.length === 0) {
    throw new Error(
      `No __NAME__ globals found in ${CLIENT_GLOBALS_DTS}. Either the declarations moved ` +
        `(point this check at their new home) or the convention changed — an empty list ` +
        `would make this gate pass on any bundle at all.`
    );
  }
  return [...new Set(names)];
}

/**
 * Which of `names` survive as bare identifiers in one emitted asset.
 *
 * Matched as a whole token so a longer identifier that merely contains the name
 * is not a hit. It DOES match the name inside a string literal, and that is
 * deliberate: a bundle whose defines were all substituted contains the token
 * nowhere at all, so the strict reading costs nothing and the loose one would
 * need a JS parser to be exact.
 *
 * @param source - The asset's text.
 * @param names - Globals from {@link parseInjectedGlobals}; `__NAME__` shaped,
 *   so they carry no regex metacharacters to escape.
 */
export function findUnsubstitutedDefines(source: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`(?<![$\\w])${name}(?![$\\w])`).test(source));
}

/**
 * Every emitted `.js` file under a directory, recursively.
 *
 * @param dir - Directory to walk.
 */
function collectScripts(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectScripts(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/**
 * Assert no declared build define survived into an emitted renderer.
 *
 * @param rendererDir - The renderer build output to read.
 * @param names - Globals from {@link parseInjectedGlobals}.
 * @returns How many assets were read.
 * @throws If an asset still carries one, naming the file and the identifier —
 *   or if there is nothing to read, which would otherwise be a silent pass over
 *   an empty or missing build.
 */
export function assertDefinesSubstituted(rendererDir: string, names: readonly string[]): number {
  // A directory that is not there and a directory with nothing in it are the
  // same mistake — the build did not run, or ran somewhere else — so they get
  // the same sentence rather than a raw ENOENT stack.
  const scripts = existsSync(rendererDir) ? collectScripts(rendererDir) : [];
  if (scripts.length === 0) {
    throw new Error(
      `No .js assets under ${rendererDir}. Run this after \`electron-vite build\`, ` +
        `not instead of it — a check that reads nothing cannot fail.`
    );
  }

  const problems: string[] = [];
  for (const file of scripts) {
    for (const name of findUnsubstitutedDefines(readFileSync(file, 'utf-8'), names)) {
      problems.push(`  ${path.relative(rendererDir, file)} still contains ${name}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The renderer bundle ships build defines that were never substituted:\n\n` +
        `${problems.join('\n')}\n\n` +
        `Add them to \`clientDefines()\` in apps/client/vite-define.ts, which both the web ` +
        `config and electron-vite's renderer section build with. Left alone, the first line ` +
        `that evaluates one throws ReferenceError before React mounts — a black window.`
    );
  }
  return scripts.length;
}

/** Read the declared globals, then read the bundle that has to have replaced them. */
function main(): void {
  const names = parseInjectedGlobals(readFileSync(CLIENT_GLOBALS_DTS, 'utf-8'));
  const checked = assertDefinesSubstituted(RENDERER_DIR, names);
  console.log(
    `  ✓ ${checked} renderer asset(s) carry no unsubstituted defines (${names.join(', ')})`
  );
}

// Only when invoked as a script: the unit test imports the checks above and
// must not trigger a read of a `dist/` that may not exist.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (err: unknown) {
    // Delete what was rejected. electron-builder packages whatever is in
    // `dist/`, so a bundle this gate refused is one `pnpm dist` away from
    // shipping — the same hazard, and the same answer, as the rejected server
    // bundle in `build-server.ts`. The cleanup must never replace the
    // diagnosis, so a failure to remove it is reported and the original error
    // still decides the exit.
    try {
      rmSync(RENDERER_DIR, { recursive: true, force: true });
    } catch (cleanupErr: unknown) {
      console.error(
        `[check-renderer-defines] Could not remove the rejected renderer at ${RENDERER_DIR} — ` +
          `delete it by hand before packaging, electron-builder would ship it:\n${String(cleanupErr)}`
      );
    }
    console.error(`\n[check-renderer-defines] Renderer bundle REJECTED:\n`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  }
}
