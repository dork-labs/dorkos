/**
 * Refuse to ship a plugin bundle that still carries an unsubstituted build
 * define.
 *
 * **Adapted from `apps/desktop/scripts/check-renderer-defines.ts`** (the
 * original, written for DOR-1448 — read that file's header for the full
 * incident). This is a local copy rather than an import: `apps/desktop` and
 * `apps/obsidian-plugin` are independent apps with no shared package between
 * them for this one script, and neither app's `scripts/` directory is meant to
 * be reached from outside it. If the check ever needs to change, change both.
 *
 * **Why this app needs its own copy of the gate, not just the desktop's.**
 * `apps/obsidian-plugin/vite.config.ts` is a THIRD bundler of the client's
 * source (`apps/client/vite.config.ts` and the desktop shell's
 * `electron.vite.config.ts` are the other two) — see `apps/client/vite-define.ts`
 * for what an unshared `define` cost the desktop build: a permanently black
 * window on every install, because a bundler never given a `define` does not
 * warn, it just ships the bare identifier (DOR-1448). Nothing in this plugin's
 * entry graph evaluates the client's `__APP_VERSION__` today, so an unshared
 * define here has not (yet) shipped a bug — that was equally true of the
 * desktop renderer right up until it wasn't (DOR-1472).
 *
 * **Checks two declaration sources, not one.** The desktop renderer only ever
 * needed to satisfy the client's own globals. This plugin's bundle also
 * inlines `apps/server/src/lib/version.ts`, whose `SERVER_VERSION` runs at
 * module-evaluation time and expects a SECOND, server-only define
 * (`__CLI_VERSION__`) that no client bundler carries. Both declaration sites
 * are parsed rather than either being listed here, for the same reason the
 * original does it: a rename or an addition is covered the day it is
 * declared, not the day someone remembers to update this file too.
 *
 * @module scripts/check-plugin-defines
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PKG = path.resolve(HERE, '..');

/** The emitted plugin bundle, exactly as a vault would load it. */
const DIST_DIR = path.resolve(PLUGIN_PKG, 'dist');

/** Where the client declares the globals every one of its bundlers must substitute. */
const CLIENT_GLOBALS_DTS = path.resolve(PLUGIN_PKG, '../client/src/vite-env.d.ts');

/**
 * Where the server declares the one global this plugin's build alone must also
 * substitute: `SERVER_VERSION` reads it at module-evaluation time, before this
 * plugin's `onload()` ever runs (see the `__CLI_VERSION__` comment in
 * `../vite.config.ts` for the ENOENT this exists to prevent).
 */
const SERVER_VERSION_SOURCE = path.resolve(PLUGIN_PKG, '../server/src/lib/version.ts');

/**
 * Every `__NAME__` global declared as a TypeScript `const` in one source file,
 * de-duplicated.
 *
 * Works on a `declare global { const __X__: string }` block (the client's
 * `vite-env.d.ts` shape) and on a plain module-local `declare const __X__: ...`
 * (the server's `version.ts` shape) alike — the regex only cares about the
 * `const __NAME__` token, not what wraps it.
 *
 * @param source - File contents to scan.
 * @param sourcePath - That file's path, named in the error if nothing is found.
 * @returns Every declared `__NAME__` global, de-duplicated.
 * @throws If the file declares none — a check with an empty list passes
 *   forever and would hide the next rename of that file's contents.
 */
export function parseInjectedGlobals(source: string, sourcePath: string): string[] {
  const names = [...source.matchAll(/\bconst\s+(__[A-Z0-9_]+__)\b/g)].map((match) => match[1]);
  if (names.length === 0) {
    throw new Error(
      `No __NAME__ globals found in ${sourcePath}. Either the declaration moved ` +
        `(point this check at its new home) or the convention changed — an empty list ` +
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
 * Assert no declared build define survived into an emitted bundle.
 *
 * @param distDir - The build output to read.
 * @param names - Globals from {@link parseInjectedGlobals}.
 * @returns How many assets were read.
 * @throws If an asset still carries one, naming the file and the identifier —
 *   or if there is nothing to read, which would otherwise be a silent pass over
 *   an empty or missing build.
 */
export function assertDefinesSubstituted(distDir: string, names: readonly string[]): number {
  // A directory that is not there and a directory with nothing in it are the
  // same mistake — the build did not run, or ran somewhere else — so they get
  // the same sentence rather than a raw ENOENT stack.
  const scripts = existsSync(distDir) ? collectScripts(distDir) : [];
  if (scripts.length === 0) {
    throw new Error(
      `No .js assets under ${distDir}. Run this after \`vite build\`, ` +
        `not instead of it — a check that reads nothing cannot fail.`
    );
  }

  const problems: string[] = [];
  for (const file of scripts) {
    for (const name of findUnsubstitutedDefines(readFileSync(file, 'utf-8'), names)) {
      problems.push(`  ${path.relative(distDir, file)} still contains ${name}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The plugin bundle ships build defines that were never substituted:\n\n` +
        `${problems.join('\n')}\n\n` +
        `Add them to the \`define\` block in apps/obsidian-plugin/vite.config.ts — either via ` +
        `\`clientDefines()\` (apps/client/vite-define.ts) if the client declared it, or directly ` +
        `if this plugin's own build is what needs it. Left alone, each survives as a bare ` +
        `identifier at runtime: an unguarded one throws ReferenceError the moment it is read ` +
        `(__APP_VERSION__'s shape), while one guarded by \`typeof\` fails more quietly further ` +
        `downstream instead (__CLI_VERSION__'s shape — see version.ts) — neither surfaces until ` +
        `a vault actually loads this build.`
    );
  }
  return scripts.length;
}

/** Read the declared globals from both sources, then read the bundle that has to have replaced them. */
function main(): void {
  const names = [
    ...parseInjectedGlobals(readFileSync(CLIENT_GLOBALS_DTS, 'utf-8'), CLIENT_GLOBALS_DTS),
    ...parseInjectedGlobals(readFileSync(SERVER_VERSION_SOURCE, 'utf-8'), SERVER_VERSION_SOURCE),
  ];
  const checked = assertDefinesSubstituted(DIST_DIR, names);
  console.log(
    `  ✓ ${checked} plugin asset(s) carry no unsubstituted defines (${names.join(', ')})`
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
    // Delete what was rejected. A vault loads whatever `main.js` is on disk,
    // so a bundle this gate refused is one copy-into-vault away from
    // shipping — the same hazard, and the same answer, as the desktop
    // renderer gate this was adapted from. The cleanup must never replace the
    // diagnosis, so a failure to remove it is reported and the original error
    // still decides the exit.
    try {
      rmSync(DIST_DIR, { recursive: true, force: true });
    } catch (cleanupErr: unknown) {
      console.error(
        `[check-plugin-defines] Could not remove the rejected build at ${DIST_DIR} — ` +
          `delete it by hand before loading it in a vault:\n${String(cleanupErr)}`
      );
    }
    console.error(`\n[check-plugin-defines] Plugin bundle REJECTED:\n`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  }
}
