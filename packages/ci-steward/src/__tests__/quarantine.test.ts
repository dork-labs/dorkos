/**
 * The quarantine lane: the list's read-time guards, the classifier that
 * decides what may enter it, and the gate that decides what it may excuse.
 *
 * The cases are chosen around one question — can this lane hide a real break?
 * — so each one bends a single input and asserts the refusal names it. The
 * end-to-end proof (a quarantined failure passing a real gate script while a
 * non-quarantined one still reds) lives in
 * `scripts/test-assert-browser-tests-executed.sh`, which drives the shell gate
 * the queue actually runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  classifyFlaky,
  readPlaywrightReport,
  readReportsIn,
  readVitestFlakeReport,
} from '../flaky.ts';
import {
  gateSuite,
  quarantineTriage,
  readQuarantine,
  renderQuarantineSummary,
  testId,
  type QuarantineEntry,
} from '../quarantine.ts';
import type { QuarantineConfig } from '../schemas.ts';

const NOW = new Date('2026-09-20T12:00:00Z');

const CFG: QuarantineConfig = {
  file: 'quarantine.json',
  max_entries: 2,
  default_expiry_days: 7,
  max_expiry_days: 14,
  window_days: 14,
  min_occurrences: 2,
  cooling_min_clean_builds: 2,
  near_expiry_hours: 48,
};

function entry(over: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    runner: 'playwright',
    file: 'rooms/canvas/room-follow.spec.ts',
    title: 'moves this window onto the document the person you follow is on',
    reason: 'races the follower window against the document the leader opens',
    evidence: {
      occurrences: 2,
      builds_sampled: 28,
      shas: ['4b8982cc2a98', '94de9c9037ac'],
      first_day: '2026-09-19',
      last_day: '2026-09-20',
      source: 'ci-steward flaky',
    },
    added_by: 'quarry',
    added_at: '2026-09-20T10:00:00Z',
    expires_at: '2026-09-27T10:00:00Z',
    ledger: '260920-180654',
    ...over,
  };
}

const list = (...entries: QuarantineEntry[]) =>
  JSON.stringify({ schema: 1, updated_at: NOW.toISOString(), entries });

describe('reading the quarantine list', () => {
  it('honours a valid list', () => {
    const r = readQuarantine(list(entry()), CFG, NOW);
    expect(r.honoured).toBe(true);
    expect(r.entries).toHaveLength(1);
  });

  it('treats an absent list as an empty lane, not as a problem', () => {
    const r = readQuarantine(null, CFG, NOW);
    expect(r.honoured).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.notes.join(' ')).toContain('no quarantine list');
  });

  it('ignores a list that is not JSON, and says every test blocks', () => {
    const r = readQuarantine('{oh no', CFG, NOW);
    expect(r.honoured).toBe(false);
    expect(r.entries).toEqual([]);
    expect(r.notes.join(' ')).toContain('Every test blocks as normal');
  });

  it('ignores a list whose entry does not validate', () => {
    const bad = JSON.stringify({
      schema: 1,
      updated_at: NOW.toISOString(),
      entries: [{ ...entry(), reason: 'too short' }],
    });
    expect(readQuarantine(bad, CFG, NOW).honoured).toBe(false);
  });

  it('ignores a list over the cap ENTIRELY rather than trimming it to fit', () => {
    const over = list(entry({ title: 'one' }), entry({ title: 'two' }), entry({ title: 'three' }));
    const r = readQuarantine(over, CFG, NOW);
    expect(r.honoured).toBe(false);
    expect(r.entries).toEqual([]);
    expect(r.notes.join(' ')).toContain('never trimmed to fit');
  });

  it('drops an expired entry at read time and says it blocks again', () => {
    const r = readQuarantine(list(entry({ expires_at: '2026-09-19T10:00:00Z' })), CFG, NOW);
    expect(r.entries).toEqual([]);
    expect(r.notes.join(' ')).toContain('it blocks again');
  });

  it('refuses a list that names the same test twice', () => {
    expect(readQuarantine(list(entry(), entry()), CFG, NOW).honoured).toBe(false);
  });

  // B-5: added_at and expires_at come out of the same unreviewed file, so a
  // guard that only compares them to each other is a guard the file can set.
  it('refuses an entry dated in the future', () => {
    const r = readQuarantine(
      list(entry({ added_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-14T00:00:00Z' })),
      CFG,
      NOW
    );
    expect(r.honoured).toBe(false);
    expect(r.notes.join(' ')).toContain('in the future');
  });

  it('refuses an entry whose expiry is beyond the ceiling from NOW, however it is dated', () => {
    // A declared life of one day, backdated so it still runs for four years.
    const r = readQuarantine(
      list(entry({ added_at: '2030-09-19T00:00:00Z', expires_at: '2030-09-20T00:00:00Z' })),
      CFG,
      NOW
    );
    expect(r.honoured).toBe(false);
  });

  it('tolerates a couple of minutes of clock skew', () => {
    const r = readQuarantine(
      list(entry({ added_at: '2026-09-20T12:01:00Z', expires_at: '2026-09-25T12:01:00Z' })),
      CFG,
      NOW
    );
    expect(r.honoured).toBe(true);
    expect(r.entries).toHaveLength(1);
  });

  it('refuses the WHOLE list when one entry gave itself more than the ceiling', () => {
    const r = readQuarantine(
      list(entry({ added_at: '2026-09-20T10:00:00Z', expires_at: '2027-09-20T10:00:00Z' })),
      CFG,
      NOW
    );
    expect(r.honoured).toBe(false);
    expect(r.notes.join(' ')).toContain('would last 365 days');
  });
});

describe('the gate', () => {
  const lane = [entry({ file: 'a.spec.ts', title: 'flaky one' })];
  const FAILED_ONE = [
    {
      runner: 'playwright' as const,
      file: 'a.spec.ts',
      title: 'flaky one',
      outcome: 'failed' as const,
    },
    {
      runner: 'playwright' as const,
      file: 'b.spec.ts',
      title: 'solid one',
      outcome: 'passed' as const,
    },
  ];
  const reported = (over: Partial<Parameters<typeof gateSuite>[0]> = {}) =>
    gateSuite({
      reported: FAILED_ONE,
      tally: 1,
      unattributed: 0,
      entries: lane,
      suiteExit: 1,
      runner: 'playwright',
      ...over,
    });

  it('absorbs a quarantined failure and names it', () => {
    const r = reported();
    expect(r.ok).toBe(true);
    expect(r.absorbed).toEqual(['playwright:a.spec.ts › flaky one']);
    expect(r.notes.join(' ')).toContain('absorbed by the quarantine lane');
  });

  it('still fails on a failure the lane does not name', () => {
    const r = reported({
      reported: [
        { runner: 'playwright', file: 'b.spec.ts', title: 'solid one', outcome: 'failed' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('are not quarantined');
  });

  it('refuses a non-zero suite whose report names no failure at all', () => {
    const r = reported({
      tally: 0,
      reported: [
        { runner: 'playwright', file: 'b.spec.ts', title: 'solid one', outcome: 'passed' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('is not a flake');
  });

  // The hole this closes: before, ONE failing quarantined test in the same
  // report switched the crash rule off, so a package dying on an import error
  // or an OOM — an exit code with no failure behind it — rode out green.
  it('refuses a crash that happened alongside an absorbed flake', () => {
    const r = reported({ tally: 1, suiteExit: 137 });
    expect(r.ok).toBe(true); // the tally IS the absorbed set: nothing else failed
    const crash = reported({
      tally: 2, // the runner counted a second failure the walk cannot name
      suiteExit: 137,
    });
    expect(crash.ok).toBe(false);
    expect(crash.failures.join(' ')).toContain('disagrees with itself');
  });

  // B-4: a test file that throws on import fails to COLLECT, so vitest counts
  // it in numFailedTestSuites and leaves numFailedTests alone. Before this, one
  // absorbed flake in the same run waved the whole unloadable file through.
  it('refuses a failure that belongs to no test, whatever else the run did', () => {
    const r = reported({ unattributed: 2 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('belong to no test');
  });

  it('refuses one even on a run the lane would otherwise fully excuse', () => {
    const r = reported({ suiteExit: 1, tally: 1, unattributed: 1 });
    expect(r.ok).toBe(false);
    expect(r.absorbed).toHaveLength(1);
    expect(r.failures.join(' ')).toContain('belong to no test');
  });

  it('refuses a report whose own tally disagrees with its per-test walk', () => {
    const r = reported({ tally: 3 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('The report disagrees with itself');
  });

  it('refuses a green-looking report whose tally says otherwise', () => {
    const r = reported({
      suiteExit: 0,
      tally: 1,
      reported: [
        { runner: 'playwright', file: 'b.spec.ts', title: 'solid one', outcome: 'passed' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('disagrees with itself');
  });

  it('ignores a lane entry for another runner', () => {
    const r = reported({
      entries: [entry({ runner: 'vitest', file: 'a.spec.ts', title: 'flaky one' })],
    });
    expect(r.ok).toBe(false);
  });

  it('reports a quarantined test that passed, as a candidate to release', () => {
    const r = reported({
      suiteExit: 0,
      tally: 0,
      reported: [
        { runner: 'playwright', file: 'a.spec.ts', title: 'flaky one', outcome: 'passed' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.recovered).toEqual(['playwright:a.spec.ts › flaky one']);
  });

  it('does not treat a SKIPPED quarantined test as a pass worth releasing', () => {
    const r = reported({
      suiteExit: 0,
      tally: 0,
      reported: [
        { runner: 'playwright', file: 'a.spec.ts', title: 'flaky one', outcome: 'skipped' },
      ],
    });
    expect(r.recovered).toEqual([]);
  });
});

describe('classifying a flake from the data', () => {
  const builds = (n: number, runner: 'playwright' | 'vitest' = 'playwright') =>
    Array.from({ length: n }, (_, i) => ({
      sha: `sha${i}`,
      day: '2026-09-20',
      runner,
    }));
  const obs = (shas: string[], title = 'sometimes') =>
    shas.map((sha) => ({
      runner: 'playwright' as const,
      file: 'a.spec.ts',
      title,
      sha,
      day: '2026-09-20',
    }));

  it('counts one occurrence per SHA, never per shard', () => {
    const c = classifyFlaky(
      [...obs(['sha1']), ...obs(['sha1']), ...obs(['sha1'])],
      builds(10),
      CFG
    );
    expect(c[0]!.occurrences).toBe(1);
    expect(c[0]!.status).toBe('below-threshold');
  });

  it('qualifies a rare flake seen recently on two different trees', () => {
    // Twice in twenty builds, the last one two builds ago: well inside its own
    // gap of ten, so nothing says the behaviour has changed.
    const c = classifyFlaky(obs(['sha10', 'sha17']), builds(20), CFG);
    expect(c[0]!.status).toBe('qualifies');
    expect(c[0]!.builds_sampled).toBe(20);
    expect(c[0]!.clean_builds_since).toBe(2);
  });

  it('calls a frequent flake that has gone quiet `cooling`, not a candidate', () => {
    // Flaked on 8 of the first 10 builds, then clean for the last 10: quiet for
    // far longer than its own gap between flakes, so it reads as FIXED.
    const c = classifyFlaky(
      obs(['sha0', 'sha1', 'sha2', 'sha3', 'sha4', 'sha5', 'sha6', 'sha7']),
      builds(20),
      CFG
    );
    expect(c[0]!.status).toBe('cooling');
    expect(c[0]!.why).toContain('looks FIXED');
  });

  it('calls even a rare flake cooling once it is quiet for longer than its own gap', () => {
    // Twice in the first two of twenty builds, then eighteen clean: that is
    // nearly twice its own gap, and it is the shape of a test somebody fixed.
    const c = classifyFlaky(obs(['sha0', 'sha1']), builds(20), CFG);
    expect(c[0]!.status).toBe('cooling');
    expect(c[0]!.clean_builds_since).toBe(18);
  });

  it('never calls a flake cooling on a single clean build', () => {
    // Every build but the last one: the floor is what stops one green build
    // from reading as a fix.
    const c = classifyFlaky(obs(Array.from({ length: 19 }, (_, i) => `sha${i}`)), builds(20), CFG);
    expect(c[0]!.clean_builds_since).toBe(1);
    expect(c[0]!.status).toBe('qualifies');
  });

  it('measures each runner against its OWN builds', () => {
    // One vitest flake on the only vitest build there is, while 20 browser
    // builds ran afterwards. Counting those against it would call it cooling.
    const c = classifyFlaky(
      [
        {
          runner: 'vitest',
          file: 'packages/x/src/__tests__/a.test.ts',
          title: 'sometimes',
          sha: 'v0',
          day: '2026-09-20',
        },
      ],
      [{ sha: 'v0', day: '2026-09-20', runner: 'vitest' }, ...builds(20)],
      CFG
    );
    expect(c[0]!.builds_sampled).toBe(1);
    expect(c[0]!.clean_builds_since).toBe(0);
  });
});

describe('reading each runner`s reports', () => {
  it('reads a Playwright report as `<file> › <title>`, recursing into nested suites', () => {
    const doc = {
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [
        {
          suites: [
            {
              specs: [
                { file: 'a.spec.ts', title: 'one', tests: [{ status: 'unexpected' }] },
                { file: 'a.spec.ts', title: 'two', tests: [{ status: 'flaky' }] },
              ],
            },
          ],
        },
      ],
    };
    const tests = readPlaywrightReport(doc);
    expect(tests.map((t) => `${testId(t)} ${t.outcome}`)).toEqual([
      'playwright:a.spec.ts › one failed',
      'playwright:a.spec.ts › two flaky',
    ]);
  });

  it('reads a vitest flake report into repo-relative paths, from any machine', () => {
    const tests = readVitestFlakeReport({
      cwd: '/home/runner/work/dorkos/dorkos/packages/harness',
      flaky: [{ file: 'src/__tests__/atomic-write.test.ts', test: 'AP-10', retries: 1 }],
    });
    expect(testId(tests[0]!)).toBe(
      'vitest:packages/harness/src/__tests__/atomic-write.test.ts › AP-10'
    );
  });
});

/**
 * `unattributed` read off REAL report shapes.
 *
 * Every `gateSuite` case above hands this number in as a literal, which is
 * exactly how a broken count reached the tree green: the gate's arithmetic was
 * right and its input was wrong. These build the file vitest and Playwright
 * actually write, so the number is derived rather than asserted.
 */
describe('counting failures that belong to no test', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function report(doc: unknown, name = 'vitest-shard-report.json'): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'unattributed-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, name), JSON.stringify(doc));
    return dir;
  }

  // The shape vitest 4.1.11 writes for ONE ordinary failing test: the file is
  // `failed` and `numFailedTestSuites` is 1, because that field counts files
  // CONTAINING a failure. Reading it as "a file that did not load" made every
  // vitest quarantine inert.
  it('counts none for an ordinary file with a failing test', () => {
    const dir = report({
      numTotalTests: 2,
      numFailedTests: 1,
      numFailedTestSuites: 1,
      success: false,
      testResults: [
        {
          name: '/w/packages/harness/src/__tests__/a.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'flaky one', status: 'failed' },
            { fullName: 'solid one', status: 'passed' },
          ],
        },
      ],
    });
    const r = readReportsIn(dir, 'vitest');
    expect(r.tally).toBe(1);
    expect(r.unattributed).toBe(0);
  });

  // The shape for a file that threw on import: failed, and no failed assertion
  // inside it, because none of its tests ever ran.
  it('counts one for a file that failed with no failed test inside it', () => {
    const dir = report({
      numTotalTests: 2,
      numFailedTests: 1,
      numFailedTestSuites: 2,
      success: false,
      testResults: [
        {
          name: '/w/packages/harness/src/__tests__/a.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'flaky one', status: 'failed' },
            { fullName: 'solid one', status: 'passed' },
          ],
        },
        {
          name: '/w/packages/harness/src/__tests__/broken.test.ts',
          status: 'failed',
          assertionResults: [],
        },
      ],
    });
    const r = readReportsIn(dir, 'vitest');
    expect(r.tally).toBe(1);
    expect(r.unattributed).toBe(1);
  });

  it('counts one when vitest calls the run failed and counts nothing', () => {
    const dir = report({
      numTotalTests: 1,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      success: false,
      testResults: [
        {
          name: '/w/packages/harness/src/__tests__/a.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'solid one', status: 'passed' }],
        },
      ],
    });
    expect(readReportsIn(dir, 'vitest').unattributed).toBe(1);
  });

  it('counts none for a clean vitest run', () => {
    const dir = report({
      numTotalTests: 1,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      success: true,
      testResults: [
        {
          name: '/w/packages/harness/src/__tests__/a.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'solid one', status: 'passed' }],
        },
      ],
    });
    const r = readReportsIn(dir, 'vitest');
    expect(r.tally).toBe(0);
    expect(r.unattributed).toBe(0);
  });

  it("reads Playwright's top-level errors, and a failing test is not one", () => {
    const failing = report(
      {
        stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
        errors: [],
        suites: [
          {
            specs: [{ file: 'a.spec.ts', title: 'one', tests: [{ status: 'unexpected' }] }],
          },
        ],
      },
      'results.json'
    );
    const clean = readReportsIn(failing, 'playwright');
    expect(clean.tally).toBe(1);
    expect(clean.unattributed).toBe(0);

    const broken = report(
      {
        stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [{ message: 'Cannot find module "./missing"' }],
        suites: [],
      },
      'results.json'
    );
    expect(readReportsIn(broken, 'playwright').unattributed).toBe(1);
  });
});

describe('the daily triage', () => {
  it('says nothing about an empty, healthy lane', () => {
    expect(quarantineTriage(readQuarantine(null, CFG, NOW), CFG, NOW)).toEqual([]);
  });

  it('flags a full lane', () => {
    const r = readQuarantine(list(entry({ title: 'one' }), entry({ title: 'two' })), CFG, NOW);
    expect(quarantineTriage(r, CFG, NOW).join(' ')).toContain('FULL');
  });

  it('flags an entry about to expire', () => {
    const r = readQuarantine(list(entry({ expires_at: '2026-09-21T00:00:00Z' })), CFG, NOW);
    expect(quarantineTriage(r, CFG, NOW).join(' ')).toContain('blocks again');
  });

  it('flags a refused list, because then nothing is quarantined', () => {
    expect(quarantineTriage(readQuarantine('nope', CFG, NOW), CFG, NOW).join(' ')).toContain(
      'REFUSED'
    );
  });
});

describe('the job summary', () => {
  it('prints the whole set, its evidence and its expiry', () => {
    const md = renderQuarantineSummary(
      readQuarantine(list(entry()), CFG, NOW),
      CFG,
      NOW,
      'Quarantine lane, this build'
    );
    expect(md).toContain('1 of 2 slot(s) in use');
    expect(md).toContain('rooms/canvas/room-follow.spec.ts');
    expect(md).toContain('2 flaky build(s) of 28');
  });

  it('says plainly when a refused list means nothing is quarantined', () => {
    const md = renderQuarantineSummary(readQuarantine('nope', CFG, NOW), CFG, NOW, 'x');
    expect(md).toContain('**nothing is quarantined**');
  });
});

describe('the phase-2 requirement this change leaves behind', () => {
  // `ratchet-assert` does not exist yet (plan §4.6, phase 2). When it is built,
  // the pass-count ratchets MUST exclude quarantined tests on both sides of
  // every comparison — otherwise quarantining a test lowers a high-water mark
  // with no release and no record, which is the exact silent lowering those
  // ratchets exist to prevent.
  //
  // Nothing in code can enforce a requirement on code that is not written. What
  // CAN be enforced is that the requirement stays written down where whoever
  // builds it will read it, so this fails if the sentence is ever dropped from
  // the ratchet it constrains.
  const ratchets = readFileSync(
    path.resolve(import.meta.dirname, '../../../../ci/ratchets.yaml'),
    'utf8'
  );

  it.each(['vitest-passed', 'playwright-passed'])(
    'the %s ratchet still says quarantined tests are excluded from both sides',
    (id) => {
      const block = ratchets.slice(ratchets.indexOf(`- id: ${id}`));
      const description = block.slice(0, block.indexOf('measured_from:'));
      expect(description).toContain(
        'Quarantined tests are excluded from both the mark and the reading'
      );
    }
  );

  it.each(['quarantine-size', 'quarantine-days'])('the %s ratchet is declared', (id) => {
    expect(ratchets).toContain(`- id: ${id}`);
  });
});
