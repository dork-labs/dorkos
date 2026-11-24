import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  HEADROOM_LINES,
  MIN_CEILING,
  NEW_PACKAGE_CEILING,
  ceilingFor,
  compare,
  countLines,
  isTestFile,
  lowered,
  measure,
  measured,
  raisedAgainst,
  ratioOf,
  readBaseline,
} from '../test-ratio/check-test-ratio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Time allowed for the test that reads every source and test file in the repo.
 * The 5s default is a claim about disk speed that a loaded machine breaks
 * (DOR-2021).
 */
const SCAN_TIMEOUT_MS = 30_000;

describe('isTestFile', () => {
  it('counts __tests__ folders and test or spec files as tests, and nothing else', () => {
    expect(isTestFile('apps/server/src/x/__tests__/helper.ts')).toBe(true);
    expect(isTestFile('apps/e2e/tests/chat.spec.ts')).toBe(true);
    expect(isTestFile('packages/relay/src/bus.test.tsx')).toBe(true);
    expect(isTestFile('packages/relay/src/bus.ts')).toBe(false);
    expect(isTestFile('packages/test-utils/src/fake-runtime.ts')).toBe(false);
  });
});

describe('countLines and ratioOf', () => {
  it('counts lines with something on them, and rounds a ratio up to two decimals', () => {
    expect(countLines('a\n\n  \nb\n')).toBe(2);
    expect(ratioOf({ source: 3, test: 1 })).toBe(0.34);
    expect(ratioOf({ source: 100, test: 131 })).toBe(1.31);
  });
});

describe('measured', () => {
  it('leaves out a package too small to measure and a test tier', () => {
    expect(
      Object.keys(
        measured({
          'apps/big': { source: 2000, test: 1000 },
          'apps/e2e': { source: 30000, test: 36000 },
          'packages/tiny': { source: 10, test: 90 },
        })
      )
    ).toEqual(['apps/big']);
  });
});

describe('ceilingFor', () => {
  it('leaves HEADROOM_LINES of test on both parts, and never a ratio under the floor', () => {
    expect(ceilingFor({ source: 10_000, test: 12_000 })).toEqual({
      ratio: ratioOf({ source: 10_000, test: 12_000 + HEADROOM_LINES }),
      tests: 12_000 + HEADROOM_LINES,
    });
    expect(ceilingFor({ source: 10_000, test: 100 }).ratio).toBe(MIN_CEILING);
  });
});

describe('compare', () => {
  const baseline = { 'apps/server': { ratio: 1.3, tests: 13_000 } };

  it('fails a package that added tests faster than source', () => {
    const lines = { source: 10_000, test: 13_500 };
    expect(compare({ 'apps/server': lines }, baseline)).toEqual([
      { kind: 'over', pkg: 'apps/server', lines, ceiling: baseline['apps/server'] },
    ]);
  });

  it('passes deleted source with no new tests, and new tests that came with new source', () => {
    expect(compare({ 'apps/server': { source: 8_000, test: 13_000 } }, baseline)).toEqual([]);
    expect(compare({ 'apps/server': { source: 12_000, test: 15_000 } }, baseline)).toEqual([]);
  });

  it('fails a package new to the baseline with more test than source', () => {
    const lines = { source: 2_000, test: 2_400 };
    expect(compare({ 'apps/new': lines }, {})).toEqual([{ kind: 'new', pkg: 'apps/new', lines }]);
  });
});

describe('raisedAgainst', () => {
  const counts = {
    'apps/client': { source: 10_000, test: 8_000 },
    'apps/new': { source: 2_000, test: 1_000 },
    'apps/server': { source: 10_000, test: 13_000 },
  };
  const base = {
    'apps/client': { ratio: 0.86, tests: 8_600 },
    'apps/server': { ratio: 1.31, tests: 13_100 },
  };

  it('refuses either part raised, a new entry looser than --update writes, and a removal', () => {
    const current = {
      'apps/client': { ratio: 0.86, tests: 9_000 },
      'apps/new': { ratio: 1.2, tests: 1_300 },
    };
    expect(raisedAgainst(current, base, counts).map((f) => [f.kind, f.pkg])).toEqual([
      ['raised', 'apps/client'],
      ['raised', 'apps/new'],
      ['dropped', 'apps/server'],
    ]);
  });

  it('accepts lowered ceilings, a new entry as --update writes it, and a package gone', () => {
    const withGone = { ...base, 'apps/gone': { ratio: 1, tests: 1_000 } };
    expect(raisedAgainst(lowered(counts, withGone), withGone, counts)).toEqual([]);
  });
});

describe('lowered', () => {
  const counts = {
    'apps/client': { source: 10_000, test: 7_700 },
    'apps/server': { source: 10_000, test: 14_000 },
    'apps/new': { source: 10_000, test: 20_000 },
  };
  const baseline = {
    'apps/client': { ratio: 0.86, tests: 8_600 },
    'apps/server': { ratio: 1.31, tests: 13_100 },
    gone: { ratio: 1, tests: 1_000 },
  };

  it('lowers each part to today plus the headroom, never up, and drops what is gone', () => {
    const next = lowered(counts, baseline);
    expect(next['apps/client']).toEqual(ceilingFor(counts['apps/client']));
    expect(next['apps/server']).toEqual(baseline['apps/server']);
    expect(next).not.toHaveProperty('gone');
  });

  it('adds a new package no looser than one line of test per line of source', () => {
    expect(lowered(counts, baseline)['apps/new']).toEqual({
      ratio: NEW_PACKAGE_CEILING,
      tests: 10_000,
    });
  });

  it('with one package named, leaves every other entry exactly as it was', () => {
    expect(lowered(counts, baseline, 'apps/client')).toEqual({
      ...baseline,
      'apps/client': ceilingFor(counts['apps/client']),
    });
  });
});

describe('readBaseline', () => {
  it('accepts a two-decimal ratio despite floating-point noise', () => {
    expect(readBaseline('{"packages":{"a":{"ratio":0.29,"tests":5}}}', 'b')).toEqual({
      a: { ratio: 0.29, tests: 5 },
    });
  });

  it('refuses a ratio with more precision, a zero, or a missing count', () => {
    for (const bad of ['{"ratio":0.123,"tests":5}', '{"ratio":0,"tests":5}', '{"ratio":1}']) {
      expect(() => readBaseline(`{"packages":{"a":${bad}}}`, 'b')).toThrow(/whole number/);
    }
  });
});

// The gate itself, as in check-own-mocks.test.ts: this test holds the budget
// in CI through `REPO_WIDE_SUITES`, which the required `typecheck` job runs.
// The loosened-by-hand check needs a base commit, so pre-push and `--base` do
// that half; review is the other guard on the baseline file.
describe('the repo', () => {
  it('keeps every package within its test budget', { timeout: SCAN_TIMEOUT_MS }, () => {
    const baseline = readBaseline(readFileSync(join(ROOT, BASELINE_PATH), 'utf8'), BASELINE_PATH);
    expect(
      compare(measure(ROOT), baseline),
      'Delete weaker tests before adding more: the rubric is in .claude/rules/testing.md, "Is this test worth keeping?". Then run `pnpm check:test-ratio -- --update --package <pkg>`.'
    ).toEqual([]);
  });
});
