/**
 * The quarantine lane end to end, through the CLI the workflows actually call.
 *
 * The unit tests next door drive `gateSuite` with a hand-built list of results.
 * These drive `main(['quarantine-gate', …])` against real report FILES on disk,
 * which is the only way to prove the part between them: that the command finds
 * the reports where the workflow points it, reads each runner's own JSON shape,
 * and turns the verdict into the exit code a step is failed by.
 *
 * The one claim worth proving twice is the one the whole lane rests on — a
 * quarantined failure leaves the build green and an unquarantined one does not
 * — so it is asserted here for vitest and in
 * `scripts/test-assert-browser-tests-executed.sh` for the browser suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const NOW = '2026-09-20T12:00:00Z';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'quarantine-cli-'));
  dirs.push(d);
  return d;
}

/**
 * A vitest json report naming one failing and one passing test.
 *
 * `numFailedTests` is vitest's OWN tally and must agree with the per-test walk;
 * the gate refuses a report where they disagree, so a fixture that leaves it
 * out is testing that refusal rather than the case it means to.
 */
function vitestReport(dir: string, failing: string): string {
  const file = path.join(dir, 'vitest-shard-report.json');
  writeFileSync(
    file,
    JSON.stringify({
      numTotalTests: 2,
      numFailedTests: 1,
      // 1, not 0: vitest counts every file CONTAINING a failure here, and this
      // file contains one. Writing 0 was what let a gate that misread this
      // field pass its own tests.
      numFailedTestSuites: 1,
      success: false,
      testResults: [
        {
          name: `${REPO}/packages/harness/src/__tests__/atomic-write.test.ts`,
          status: 'failed',
          assertionResults: [
            { fullName: failing, status: 'failed' },
            { fullName: 'a test that is fine', status: 'passed' },
          ],
        },
      ],
    })
  );
  return file;
}

/** A quarantine list file in the shape `quarantine-list --out` writes. */
function laneFile(dir: string, titles: string[]): string {
  const file = path.join(dir, 'quarantine.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      updated_at: NOW,
      entries: titles.map((title) => ({
        runner: 'vitest',
        file: 'packages/harness/src/__tests__/atomic-write.test.ts',
        title,
        reason: 'races a concurrent reader against a partially written file',
        evidence: {
          occurrences: 2,
          builds_sampled: 30,
          shas: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
          first_day: '2026-09-18',
          last_day: '2026-09-20',
          source: 'ci-steward flaky',
        },
        added_by: 'a test',
        added_at: NOW,
        expires_at: '2026-09-27T12:00:00Z',
        ledger: '260920-180654',
      })),
    })
  );
  return file;
}

function run(args: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = main([...args, '--root', REPO, '--now', NOW], {
    out: (s) => (out += s),
    err: (s) => (err += s),
  });
  return { code, out, err };
}

const gate = (report: string, list: string, exit = 1) => [
  'quarantine-gate',
  '--runner',
  'vitest',
  '--suite-exit',
  String(exit),
  '--list',
  list,
  '--reports',
  report,
];

describe('quarantine-gate, as the queue runs it', () => {
  // B-6: the whole point of the vitest lane. Its report is the one vitest
  // really writes for a lone failing test, so a gate that misreads any field in
  // it makes this inert — which is what happened, green, for a whole round.
  it('lets a quarantined failure through, and names what it absorbed', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-10: never lets a reader observe a half-written file');
    const list = laneFile(dir, ['AP-10: never lets a reader observe a half-written file']);
    const r = run(gate(report, list));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 failure(s) absorbed by the quarantine lane');
    expect(r.out).toContain('PASS');
  });

  it('still reds the build on a failure the lane does not name', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-11: a different test entirely');
    const list = laneFile(dir, ['AP-10: never lets a reader observe a half-written file']);
    const r = run(gate(report, list));
    expect(r.code).toBe(1);
    expect(r.err).toContain('are not quarantined');
    expect(r.err).toContain('AP-11');
  });

  it('refuses a failed sweep that left no report to read', () => {
    const dir = scratch();
    const r = run(gate(path.join(dir, 'nothing-here'), laneFile(dir, [])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('left no readable vitest report');
  });

  it('passes a green sweep with no report, which is another gate`s business', () => {
    const dir = scratch();
    const r = run(gate(path.join(dir, 'nothing-here'), laneFile(dir, []), 0));
    expect(r.code).toBe(0);
  });

  it('refuses a non-zero sweep whose report names no failure at all', () => {
    const dir = scratch();
    const file = path.join(dir, 'vitest-shard-report.json');
    writeFileSync(
      file,
      JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        testResults: [
          {
            name: `${REPO}/packages/harness/src/__tests__/atomic-write.test.ts`,
            assertionResults: [{ fullName: 'fine', status: 'passed' }],
          },
        ],
      })
    );
    const r = run(gate(file, laneFile(dir, [])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not a flake');
  });

  it('blocks everything when the list itself is unreadable', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-10: never lets a reader observe a half-written file');
    const list = path.join(dir, 'broken.json');
    writeFileSync(list, '{ not json');
    const r = run(gate(report, list));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Every test blocks as normal');
  });

  it('honours nothing from an expired entry', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-10: never lets a reader observe a half-written file');
    const list = path.join(dir, 'expired.json');
    const fresh = laneFile(dir, ['AP-10: never lets a reader observe a half-written file']);
    writeFileSync(
      list,
      JSON.stringify({
        schema: 1,
        updated_at: NOW,
        entries: (
          JSON.parse(readFileSync(fresh, 'utf8')) as { entries: Record<string, unknown>[] }
        ).entries.map((e) => ({
          ...e,
          expires_at: '2026-09-19T00:00:00Z',
        })),
      })
    );
    const r = run(gate(report, list));
    expect(r.code).toBe(1);
    expect(r.out).toContain('it blocks again');
  });

  it('walks a directory of per-package reports, as the shard job points it at', () => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'packages', 'harness'), { recursive: true });
    const report = vitestReport(path.join(dir, 'packages', 'harness'), 'AP-10: flaky');
    expect(report).toContain('packages/harness');
    const r = run(gate(dir, laneFile(dir, ['AP-10: flaky'])));
    expect(r.code).toBe(0);
  });

  it('refuses a report whose own tally disagrees with the tests it names', () => {
    const dir = scratch();
    const file = path.join(dir, 'vitest-shard-report.json');
    writeFileSync(
      file,
      JSON.stringify({
        numTotalTests: 2,
        numFailedTests: 2, // vitest counted two; the walk below names one
        testResults: [
          {
            name: `${REPO}/packages/harness/src/__tests__/atomic-write.test.ts`,
            assertionResults: [
              { fullName: 'AP-10: flaky', status: 'failed' },
              { fullName: 'fine', status: 'passed' },
            ],
          },
        ],
      })
    );
    const r = run(gate(file, laneFile(dir, ['AP-10: flaky'])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('disagrees with itself');
  });

  it('refuses a missing --list rather than reading it as an empty lane', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-10: flaky');
    const r = run(gate(report, path.join(dir, 'never-written.json')));
    expect(r.code).toBe(1);
    expect(r.err).toContain('no quarantine list at');
  });

  it('refuses an empty --suite-exit, which is not zero', () => {
    const dir = scratch();
    const report = vitestReport(dir, 'AP-10: flaky');
    const list = laneFile(dir, ['AP-10: flaky']);
    const r = run([
      'quarantine-gate',
      '--runner',
      'vitest',
      '--suite-exit',
      '',
      '--list',
      list,
      '--reports',
      report,
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('An empty value is not zero');
  });

  // B-4, with the real vitest 4.1.11 shape: a test file that throws on import
  // fails to COLLECT, so it lands in numFailedTestSuites and never becomes a
  // failed test. One quarantined flake in the same run used to wave it through.
  it('refuses an unloadable test file even when the only named failure is absorbed', () => {
    const dir = scratch();
    const file = path.join(dir, 'vitest-shard-report.json');
    writeFileSync(
      file,
      JSON.stringify({
        numTotalTests: 2,
        numFailedTests: 1,
        numFailedTestSuites: 2,
        success: false,
        testResults: [
          {
            name: `${REPO}/packages/harness/src/__tests__/atomic-write.test.ts`,
            status: 'failed',
            assertionResults: [
              { fullName: 'AP-10: flaky', status: 'failed' },
              { fullName: 'fine', status: 'passed' },
            ],
          },
          {
            // Threw on import: failed, and not one of its tests ever ran.
            name: `${REPO}/packages/harness/src/__tests__/broken.test.ts`,
            status: 'failed',
            assertionResults: [],
          },
        ],
      })
    );
    const r = run(gate(file, laneFile(dir, ['AP-10: flaky'])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('belong to no test');
  });

  it('refuses a run vitest itself calls failed while counting nothing', () => {
    const dir = scratch();
    const file = path.join(dir, 'vitest-shard-report.json');
    writeFileSync(
      file,
      JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        success: false,
        testResults: [
          {
            name: `${REPO}/packages/harness/src/__tests__/atomic-write.test.ts`,
            status: 'passed',
            assertionResults: [{ fullName: 'fine', status: 'passed' }],
          },
        ],
      })
    );
    const r = run(gate(file, laneFile(dir, [])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('belong to no test');
  });
});

describe('quarantine-list, as the queue runs it', () => {
  it('refuses to write a list without being told which runner it is for', () => {
    const r = run(['quarantine-list', '--lines', '/dev/null']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('needs --runner');
  });
});

/**
 * A `git` that answers `show` with a fixed list, so the add/remove/reset paths
 * can be driven against a data branch that does not exist here.
 */
function gitServing(listText: string | null) {
  return (_cwd: string, args: readonly string[]): string => {
    if (args[0] === 'fetch') return '';
    if (args[0] === 'show') {
      if (listText === null) throw new Error('no such path');
      return listText;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function runWithList(
  args: string[],
  listText: string | null
): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = main(
    [...args, '--root', REPO, '--now', NOW],
    { out: (s) => (out += s), err: (s) => (err += s) },
    REPO,
    { git: gitServing(listText) }
  );
  return { code, out, err };
}

/** A list that every reader refuses: three entries against a cap of ten... */
function overCapList(): string {
  const entry = (title: string) => ({
    runner: 'vitest',
    file: 'packages/harness/src/__tests__/atomic-write.test.ts',
    title,
    reason: 'races a concurrent reader against a partially written file',
    evidence: {
      occurrences: 2,
      builds_sampled: 30,
      shas: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
      first_day: '2026-09-18',
      last_day: '2026-09-20',
      source: 'ci-steward flaky',
    },
    added_by: 'a test',
    added_at: NOW,
    // Past the ceiling, which is what makes every reader refuse the whole list.
    expires_at: '2027-09-20T12:00:00Z',
    ledger: '260920-180654',
  });
  return JSON.stringify({ schema: 1, updated_at: NOW, entries: [entry('one'), entry('two')] });
}

describe('getting back out of a list no reader will honour', () => {
  const remove = (title: string) => [
    'quarantine',
    'remove',
    '--runner',
    'vitest',
    '--file',
    'packages/harness/src/__tests__/atomic-write.test.ts',
    '--title',
    title,
  ];

  it('refuses to ADD to it', () => {
    const r = runWithList(
      [
        'quarantine',
        'add',
        '--runner',
        'vitest',
        '--file',
        'packages/harness/src/__tests__/atomic-write.test.ts',
        '--title',
        'three',
        '--reason',
        'a reason long enough to satisfy the schema here',
      ],
      overCapList()
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('nothing may be ADDED to it blind');
  });

  it('still lets you REMOVE from it, which is the repair', () => {
    const r = runWithList(remove('one'), overCapList());
    expect(r.code).toBe(0);
    expect(r.out).toContain('removing from it is a repair');
    expect(r.out).toContain('"title": "two"');
    expect(r.out).not.toContain('"title": "one"');
  });

  it('resets a file that does not parse at all', () => {
    const r = runWithList(['quarantine', 'reset'], '{ not json at all');
    expect(r.code).toBe(0);
    expect(r.out).toContain('"entries": []');
  });

  it('says so plainly when there is nothing to remove from', () => {
    const r = runWithList(remove('one'), '{ not json at all');
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not parse at all');
  });
});

describe('a vitest entry the union check could never watch', () => {
  it('is refused at add time rather than accepted and skipped', () => {
    const r = runWithList(
      [
        'quarantine',
        'add',
        '--runner',
        'vitest',
        '--file',
        'scripts/some-helper.test.ts',
        '--title',
        'a test outside any workspace package',
        '--reason',
        'a reason long enough to satisfy the schema here',
      ],
      null
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not a workspace test file');
  });
});
