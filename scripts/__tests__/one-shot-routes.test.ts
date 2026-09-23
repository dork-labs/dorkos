import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Browser suites must not use Playwright's `{ times: n }` route option (DOR-2228).
 *
 * When a `times` route runs out, Playwright unregisters it asynchronously, and a
 * matching request the page sends in that window can be caught with no handler
 * left to answer it. It never reaches the server and the test hangs until its
 * timeout. PR #1999 hit it on the owner-claim spec; the audit that followed found
 * the same shape (a failure route, then a retry against the same URL) at every
 * `times:` site in these folders. `interceptNext` from
 * `@dorkos/test-utils/playwright-routes` does the same job without ever
 * unregistering.
 *
 * A site that genuinely cannot see a later matching request may keep `times:`
 * with a marker on the same line or the line directly above it, naming why:
 *
 *     // one-shot-route-allow: the page makes exactly one request to this URL
 */
const SCANNED_ROOTS = ['apps/community/browser-tests', 'apps/e2e'] as const;
const ALLOW_MARKER = 'one-shot-route-allow:';
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

/** Return `path:line` for every unmarked `times:` in one file's source. */
function unmarkedTimesOptions(path: string, source: string): string[] {
  const lines = source.split('\n');
  return lines.flatMap((line, index) =>
    TIMES_OPTION.test(line) && !hasReasonedAllow(line) && !hasReasonedAllow(lines[index - 1])
      ? [`${path}:${index + 1}: ${line.trim()}`]
      : []
  );
}

/** Tracked and untracked (not ignored) source files under the scanned roots. */
function scannedFiles(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCANNED_ROOTS.flatMap((root) =>
        ['ts', 'tsx', 'js', 'mjs'].map((ext) => `${root}/*.${ext}`)
      ),
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((path) => path.length > 0 && existsSync(path));
}

describe('one-shot Playwright routes in browser suites', () => {
  it('finds no unmarked `times:` route option', () => {
    const files = scannedFiles();
    // Both roots must actually be scanned, or an emptied glob would pass silently.
    for (const root of SCANNED_ROOTS) {
      expect(files.some((path) => path.startsWith(`${root}/`))).toBe(true);
    }

    const violations = files.flatMap((path) =>
      unmarkedTimesOptions(path, readFileSync(path, 'utf8'))
    );
    expect(
      violations,
      'Use interceptNext from @dorkos/test-utils/playwright-routes instead of `{ times: n }`, ' +
        `or mark a site that cannot see a later matching request with "// ${ALLOW_MARKER} <why>".`
    ).toEqual([]);
  });

  it('flags the risky shape and accepts only a reasoned marker', () => {
    const risky = "await page.route('**/claim', handler, { times: 1 });";
    expect(unmarkedTimesOptions('x.ts', risky)).toEqual([`x.ts:1: ${risky}`]);
    expect(unmarkedTimesOptions('x.ts', "page.route('**/x', h,\n  { times: 2 }\n);")).toHaveLength(
      1
    );

    const reason = 'the page makes exactly one request to this URL';
    expect(unmarkedTimesOptions('x.ts', `${risky} // ${ALLOW_MARKER} ${reason}`)).toEqual([]);
    expect(unmarkedTimesOptions('x.ts', `// ${ALLOW_MARKER} ${reason}\n${risky}`)).toEqual([]);
    // A bare or placeholder marker is not a reason.
    expect(unmarkedTimesOptions('x.ts', `// ${ALLOW_MARKER}\n${risky}`)).toHaveLength(1);
    expect(unmarkedTimesOptions('x.ts', `${risky} // ${ALLOW_MARKER} ok`)).toHaveLength(1);
    // A marker two lines up covers nothing.
    expect(unmarkedTimesOptions('x.ts', `// ${ALLOW_MARKER} ${reason}\n\n${risky}`)).toHaveLength(
      1
    );
    // Other keys ending in "times" are not the route option.
    expect(unmarkedTimesOptions('x.ts', 'const patch = { runtimes: { a: 1 } };')).toEqual([]);
  });
});
