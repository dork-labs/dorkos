/**
 * Floors, the constraint, the weekly report and status, and the daily
 * workflow's command sequence end to end (prepare, daily, publish, report,
 * tag) against a temporary bare origin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { localExportDays, type SloReading } from '../data.ts';
import { pickConstraint, updateFloors } from '../floors.ts';
import { replayGh } from '../gh.ts';
import { loadHandFiles } from '../load.ts';
import { baseSpec, writeRepo } from './fixture.ts';
import { DAY, dayRecording } from './gh-fixture.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const slos = loadHandFiles(REPO).files!.slos!;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reading(
  id: string,
  status: SloReading['status'],
  stats: Record<string, number> = {},
  excess: number | null = null
): SloReading {
  const slo = slos.slos.find((s) => s.id === id)!;
  return {
    id,
    kind: slo.kind,
    from: '2026-09-14',
    to: '2026-09-20',
    n: 100,
    min_n: 1,
    stats,
    status,
    excess_hours: excess,
  };
}

describe('floors', () => {
  const weeks = ['2026-W35', '2026-W36', '2026-W37', '2026-W38'];

  it('tighten halfway to the objective after 4 consecutive met-or-ok weeks, and only then', () => {
    let floors = null;
    const changes: string[] = [];
    for (const w of weeks) {
      const r = updateFloors(
        slos,
        floors,
        w,
        [reading('queue-green', w === '2026-W35' ? 'met' : 'ok')],
        [],
        new Date('2026-09-21T05:00:00Z')
      );
      floors = r.floors;
      changes.push(...r.changes);
    }
    expect(changes).toEqual(['queue-green share floor tightened 0.75 -> 0.86']);
    expect(floors!.slos['queue-green']!.floor).toEqual({ share: 0.86 });
    // The streak restarts after a move: one more good week moves nothing.
    const next = updateFloors(
      slos,
      floors,
      '2026-W39',
      [reading('queue-green', 'ok')],
      [],
      new Date()
    );
    expect(next.changes).toEqual([]);
  });

  it('never loosen on a breach, and a gap in the weeks breaks the streak', () => {
    let floors = null;
    for (const w of ['2026-W33', '2026-W35', '2026-W36', '2026-W37']) {
      floors = updateFloors(slos, floors, w, [reading('pr-feedback', 'ok')], [], new Date()).floors;
    }
    expect(floors!.slos['pr-feedback']!.floor).toEqual({ p90: 40 });
    floors = updateFloors(
      slos,
      floors,
      '2026-W38',
      [reading('pr-feedback', 'breach')],
      [],
      new Date()
    ).floors;
    expect(floors.slos['pr-feedback']!.floor).toEqual({ p90: 40 });
  });

  it('loosen only through a ledger floor-release, applied once', () => {
    const rel = [
      {
        ledgerId: '260920-010101',
        slo: 'queue-green',
        stat: 'share',
        value: 0.7,
        reason: 'the browser suite doubled',
      },
    ];
    const a = updateFloors(slos, null, '2026-W38', [], rel, new Date());
    expect(a.floors.slos['queue-green']!.floor).toEqual({ share: 0.7 });
    const b = updateFloors(slos, a.floors, '2026-W39', [], rel, new Date());
    expect(b.changes).toEqual([]);
  });
});

describe('the constraint', () => {
  it('ranks a health failure first, then tripwires, then quality in file order, then excess wait-hours', () => {
    const quiet = [
      reading('queue-green', 'ok'),
      reading('pr-feedback', 'ok', { p90: 30 }, 12),
      reading('queue-build', 'ok', { p90: 40 }, 30),
    ];
    expect(pickConstraint(slos, quiet, ['Truncated'])).toMatchObject({
      tier: 'tripwire',
      id: 'collector-health',
    });
    expect(
      pickConstraint(
        slos,
        [...quiet, reading('headroom', 'breach', { p95_over_timeout: 0.95 })],
        []
      )
    ).toMatchObject({ tier: 'tripwire', id: 'headroom' });
    const quality = [
      ...quiet,
      reading('main-green', 'breach'),
      reading('wasted-queue-builds', 'breach'),
    ];
    expect(pickConstraint(slos, quality, [])).toMatchObject({
      tier: 'quality',
      id: 'wasted-queue-builds',
    });
    expect(pickConstraint(slos, quiet, [])).toMatchObject({ tier: 'speed', id: 'queue-build' });
    expect(pickConstraint(slos, [reading('queue-green', 'met')], [])).toMatchObject({
      tier: 'none',
      id: null,
    });
  });
});

describe('the daily workflow sequence, end to end against a bare origin', () => {
  function world() {
    const base = mkdtempSync(path.join(tmpdir(), 'ci-steward-e2e-'));
    dirs.push(base);
    const spec = baseSpec();
    (spec.config.collect as { lookback_days: number }).lookback_days = 1;
    const root = writeRepo(spec, path.join(base, 'repo'));
    const origin = path.join(base, 'origin.git');
    const g = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        cwd,
        encoding: 'utf8',
      }).trim();
    g(base, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'init', '-q', '-b', 'main');
    g(root, 'add', '-A');
    g(root, 'commit', '-qm', 'main');
    g(root, 'remote', 'add', 'origin', origin);
    g(root, 'push', '-q', 'origin', 'main');
    return { root, origin, data: path.join(base, 'data'), g };
  }
  const run = (root: string, argv: string[], summary?: string) => {
    let out = '';
    let err = '';
    const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s) }, root, {
      gh: (b) =>
        replayGh(dayRecording(), b, (dir, rel, text) => {
          mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          writeFileSync(path.join(dir, rel), text);
        }),
      stepSummary: summary,
    });
    return { code, out, err };
  };

  // 60s, against vitest's 5s default, because this one test drives the WHOLE
  // daily sequence for real: `git init` twice, a bare origin, a push, a full
  // collect, a publish, a week tag, a Monday report and a status read. It
  // measures 5.7-6.0s on this machine, which is over the default already, and
  // it went red in three of six full-suite runs once two more test files
  // joined the package and the workers started competing. A timeout is not a
  // retry budget and nothing here is racy — the clocks are fixed, the gh calls
  // are replayed and the repo is a fresh temp dir; the ceiling was simply set
  // below what the test costs. 60s is a ceiling on a wedged `git`, not a
  // budget: if this ever approaches it, something is genuinely wrong.
  it(
    'creates the branch, collects, publishes, reports on Monday, tags the week, and status reads it',
    { timeout: 60_000 },
    () => {
      const w = world();
      const SAT = '2026-09-19T05:00:00Z';
      const MON = '2026-09-21T05:00:00Z';
      expect(run(w.root, ['data-prepare', '--data', w.data, '--now', SAT]).out).toContain(
        'created the ci-steward-data branch'
      );
      const daily = run(w.root, ['daily', '--data', w.data, '--now', SAT]);
      expect(daily).toMatchObject({ code: 0 });
      expect(daily.out).toContain(`collected ${DAY}`);
      // The daily run also triages and writes the day's human-readable page.
      expect(daily.out).toContain('triggers:');
      expect(daily.out).toContain(`wrote reports/${DAY}.html`);
      expect(readFileSync(path.join(w.data, `reports/${DAY}.html`), 'utf8')).toContain(
        `<title>CI report for ${DAY}</title>`
      );
      expect(readFileSync(path.join(w.data, 'reports/index.html'), 'utf8')).toContain(
        `${DAY}.html`
      );
      const sat = run(w.root, ['data-publish', '--data', w.data, '--tag-week', '--now', SAT]).out;
      expect(sat).toContain('pushed');
      // Any day tags a week that has no backup yet, not only Monday.
      expect(sat).toContain('tagged ci-steward-data/2026-W38');
      expect(run(w.root, ['data-publish', '--data', w.data, '--tag-week', '--now', SAT]).out).toBe(
        'nothing to publish\n'
      );
      expect(run(w.root, ['report', '--data', w.data, '--now', MON]).out).toContain(
        'wrote reports/2026-W38.md'
      );
      const report = readFileSync(path.join(w.data, 'reports/2026-W38.md'), 'utf8');
      for (const h of [
        '## SLO trend',
        '## The constraint',
        '## Verdicts',
        '## Real catches per gate',
        '## Tracked metrics',
        '## Collector health',
      ]) {
        expect(report).toContain(h);
      }
      expect(report).toContain('| `wf.test.test-shard` | 1 | 1 |');
      // Deterministic: the same inputs render the same bytes.
      run(w.root, ['report', '--data', w.data, '--now', MON]);
      expect(readFileSync(path.join(w.data, 'reports/2026-W38.md'), 'utf8')).toBe(report);
      expect(
        run(w.root, ['data-publish', '--data', w.data, '--tag-week', '--now', MON]).out
      ).toContain('tagged ci-steward-data/2026-W39');
      expect(w.g(w.origin, 'ls-tree', '-r', '--name-only', 'ci-steward-data')).toContain(
        'snapshots/2026-09-18.json'
      );
      w.g(
        w.root,
        'fetch',
        '-q',
        'origin',
        '+refs/heads/ci-steward-data:refs/remotes/origin/ci-steward-data'
      );
      const status = run(w.root, ['status', '--now', '2026-09-21T06:00:00Z']).out;
      expect(status).toContain(
        'CI Steward status: data for 2026-09-18 from origin/ci-steward-data'
      );
      expect(status).toContain('Health: OK');
      expect(status).toContain(
        'Weekly deep summary: git show origin/ci-steward-data:reports/2026-W38.md'
      );
      expect(status).toContain('Triggers (');
    }
  );

  it('keeps a failing step to itself, so the exit code still means the collector', () => {
    const w = world();
    const SAT = '2026-09-19T05:00:00Z';
    run(w.root, ['data-prepare', '--data', w.data, '--now', SAT]);
    // `reports` as a FILE makes every write under it fail, so the daily page
    // cannot be written. Nothing else about the run should change. Each step
    // of `daily` is wrapped on its own (triage, the page, and on Mondays the
    // weekly deep summary), so one failing never skips the next.
    mkdirSync(w.data, { recursive: true });
    writeFileSync(path.join(w.data, 'reports'), 'not a directory');
    const daily = run(w.root, ['daily', '--data', w.data, '--now', SAT]);
    // The exit code is the collector's health, not the renderer's luck.
    expect(daily.code).toBe(0);
    expect(daily.err).toContain('the daily report failed:');
    expect(daily.err).not.toContain('triage failed:');
    // Everything that did not depend on it still landed.
    expect(daily.out).toContain('triggers:');
    expect(existsSync(path.join(w.data, 'triggers.json'))).toBe(true);
    expect(existsSync(path.join(w.data, 'latest.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(w.data, 'latest.json'), 'utf8')) as { triggers?: unknown }
    ).toHaveProperty('triggers');
  });

  it('writes a heartbeat on every local export, so an idle clone never reads as stale', () => {
    const w = world();
    run(w.root, ['data-prepare', '--data', w.data]);
    run(w.root, ['data-publish', '--data', w.data]);
    const out = run(w.root, [
      'local-export',
      '--clone',
      'clone-x',
      '--now',
      '2026-09-19T04:30:00Z',
    ]).out;
    expect(out).toContain('clone clone-x: 0 finished days');
    expect(
      JSON.parse(w.g(w.origin, 'show', 'ci-steward-data:local/clone-x/exported.json'))
    ).toEqual({
      schema: 1,
      clone: 'clone-x',
      exported_at: '2026-09-19T04:30:00.000Z',
    });
    w.g(w.data, 'pull', '-q', 'origin', 'ci-steward-data');
    expect(localExportDays(w.data)).toEqual({ 'clone-x': '2026-09-19' });
  });

  it('refuses to recreate a lost branch, naming the restore command in the job summary', () => {
    const w = world();
    run(w.root, ['data-prepare', '--data', w.data]);
    run(w.root, ['data-publish', '--data', w.data]);
    w.g(w.data, 'tag', 'ci-steward-data/2026-W38');
    w.g(w.data, 'push', '-q', 'origin', 'refs/tags/ci-steward-data/2026-W38');
    w.g(w.origin, 'update-ref', '-d', 'refs/heads/ci-steward-data');
    const summary = path.join(path.dirname(w.data), 'summary.md');
    const r = run(
      w.root,
      ['data-prepare', '--data', path.join(path.dirname(w.data), 'data2')],
      summary
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('will not recreate it');
    expect(readFileSync(summary, 'utf8')).toContain(
      "git push origin 'ci-steward-data/2026-W38^{commit}:refs/heads/ci-steward-data'"
    );
    expect(w.g(w.origin, 'branch', '--list', 'ci-steward-data')).toBe('');
  });
});
