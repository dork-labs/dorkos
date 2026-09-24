/**
 * Refuse Playwright's `{ times: n }` route option in the browser suites (DOR-2228).
 *
 * WHAT WAS OBSERVED. PR #1999 found that after a `page.route(url, handler,
 * { times: 1 })` route had run, a later request the page sent to the same URL
 * could hang: it never reached the server, and the test waited out its timeout.
 * The DOR-2228 audit then found the same shape (a failure route followed by a
 * retry against the same URL) at every `times:` site in these folders, and
 * replaced them all. The exact mechanism inside Playwright was not pinned down.
 * The likely one is the moment the exhausted route is retired while the page's
 * next matching request is already on its way, so treat any later matching
 * request as exposed.
 *
 * `interceptNext` from `@dorkos/test-utils/playwright-routes` does the same job
 * without ever retiring its route, so it has no such moment.
 *
 * WHAT THIS CHECKS, AND WHAT IT CANNOT. The check is line-based: it flags any
 * line under the scanned roots that contains a `times:` property. So it
 *   - misses the option written as shorthand (`{ times }`) or built somewhere
 *     else and passed in as a variable, and
 *   - can flag an innocent line, such as a comment reading "three times: ...".
 * A site that genuinely cannot see a later matching request, or a line that is
 * not a route option at all, keeps its `times:` with a marker on the same line
 * or the line directly above, giving the reason:
 *
 *     // one-shot-route-allow: the page makes exactly one request to this URL
 *
 * Runs as its own step in the required `typecheck` job (typecheck.yml), which
 * is unfiltered and reports on `merge_group`. The unit suite
 * `scripts/__tests__/one-shot-routes.test.ts` pins the matcher.
 *
 * Usage: `pnpm run check:one-shot-routes [repo-root]`. Exit 1 on any hit.
 *
 * @module check-one-shot-routes
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folders whose source is scanned, relative to the repository root. */
export const SCANNED_ROOTS = [
  'apps/community/browser-tests',
  'apps/community/acceptance',
  'apps/e2e',
] as const;

/** The marker that keeps a reasoned `times:` line. */
export const ALLOW_MARKER = 'one-shot-route-allow:';

/** A reason shorter than this is a placeholder, not a reason. */
const MIN_REASON_LENGTH = 12;

/** Match a `times:` property. `\b` keeps `runtimes:` and friends out. */
const TIMES_OPTION = /\btimes\s*:/u;

/** Return whether `line` carries an allow marker with a real reason after it. */
function hasReasonedAllow(line: string | undefined): boolean {
  if (!line) return false;
  const at = line.indexOf(ALLOW_MARKER);
  if (at === -1) return false;
  return line.slice(at + ALLOW_MARKER.length).trim().length >= MIN_REASON_LENGTH;
}

/**
 * Return `path:line: text` for every unmarked `times:` line in one file's source.
 *
 * @param path - The path to report the hits under.
 * @param source - The file's contents.
 */
export function unmarkedTimesOptions(path: string, source: string): string[] {
  const lines = source.split('\n');
  return lines.flatMap((line, index) =>
    TIMES_OPTION.test(line) && !hasReasonedAllow(line) && !hasReasonedAllow(lines[index - 1])
      ? [`${path}:${index + 1}: ${line.trim()}`]
      : []
  );
}

/**
 * Tracked and untracked (not ignored) source files under the scanned roots,
 * relative to `repoRoot`.
 *
 * @param repoRoot - The repository root to list from.
 */
export function scannedFiles(repoRoot: string): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      // A git pathspec `*` crosses directory boundaries, so this reaches every depth.
      ...SCANNED_ROOTS.flatMap((root) =>
        ['ts', 'tsx', 'js', 'mjs'].map((ext) => `${root}/*.${ext}`)
      ),
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((path) => path.length > 0 && existsSync(join(repoRoot, path)));
}

/** What one run of the gate found. */
export interface OneShotRouteReport {
  /** Every scanned file, relative to the repository root. */
  files: string[];
  /** Scanned roots that yielded no file at all: a sign the glob or a folder moved. */
  emptyRoots: string[];
  /** Every unmarked `times:` line, as `path:line: text`. */
  violations: string[];
}

/**
 * Scan every root and report unmarked `times:` lines and empty roots.
 *
 * @param repoRoot - The repository root to scan.
 */
export function runOneShotRouteGate(repoRoot: string): OneShotRouteReport {
  const files = scannedFiles(repoRoot);
  return {
    files,
    emptyRoots: SCANNED_ROOTS.filter((root) => !files.some((path) => path.startsWith(`${root}/`))),
    violations: files.flatMap((path) =>
      unmarkedTimesOptions(path, readFileSync(join(repoRoot, path), 'utf8'))
    ),
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const { files, emptyRoots, violations } = runOneShotRouteGate(repoRoot);

  if (emptyRoots.length > 0) {
    console.error(
      `check-one-shot-routes: no source files found under ${emptyRoots.join(', ')}. ` +
        'A root that scans nothing passes silently, so update SCANNED_ROOTS in ' +
        'scripts/check-one-shot-routes.ts if the folder moved.'
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`check-one-shot-routes: ${violations.length} unmarked \`times:\` line(s):\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      '\nA later request to the same URL can hang after a `{ times: n }` route runs out. ' +
        'Use interceptNext from @dorkos/test-utils/playwright-routes instead. If this ' +
        'site cannot see a later matching request, or the line is not a route option, ' +
        `mark it with "// ${ALLOW_MARKER} <why>" on the same line or the line above.`
    );
    process.exit(1);
  }

  console.log(
    `check-one-shot-routes: clean — 0 hits across ${files.length} files in ${SCANNED_ROOTS.join(', ')}.`
  );
}
