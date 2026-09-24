import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_MARKER,
  SCANNED_ROOTS,
  runOneShotRouteGate,
  unmarkedTimesOptions,
} from '../check-one-shot-routes.ts';

/**
 * Pins the matcher behind `pnpm run check:one-shot-routes` (DOR-2228). The gate
 * itself is enforced by its own step in the required `typecheck` job; this suite
 * proves the mechanism, and its real-repo case is a second canary.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('check-one-shot-routes', () => {
  it('finds no unmarked `times:` line in the real repository', () => {
    const { files, emptyRoots, violations } = runOneShotRouteGate(REPO_ROOT);
    expect(emptyRoots).toEqual([]);
    for (const root of SCANNED_ROOTS) {
      expect(files.some((path) => path.startsWith(`${root}/`))).toBe(true);
    }
    expect(violations).toEqual([]);
  });

  it('flags the risky shape and accepts only a reasoned marker', () => {
    const risky = "await page.route('**/claim', handler, { times: 1 });";
    expect(unmarkedTimesOptions('x.ts', risky)).toEqual([`x.ts:1: ${risky}`]);
    expect(unmarkedTimesOptions('x.ts', "page.route('**/x', h,\n  { times: 2 }\n);")).toEqual([
      'x.ts:2: { times: 2 }',
    ]);

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

  it('is line-based: documented blind spots stay blind, documented false hits stay hits', () => {
    // Shorthand and options built elsewhere are invisible to a line scan.
    expect(unmarkedTimesOptions('x.ts', "page.route('**/x', h, { times });")).toEqual([]);
    expect(unmarkedTimesOptions('x.ts', "page.route('**/x', h, once);")).toEqual([]);
    // A prose comment with the same shape is flagged, and the marker is the way out.
    expect(unmarkedTimesOptions('x.ts', '// retried three times: then it gives up')).toHaveLength(
      1
    );
  });
});
