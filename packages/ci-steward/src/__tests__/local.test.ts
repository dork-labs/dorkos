/**
 * Local hook timings end to end: the POSIX time-wrap under every shell this
 * machine has, the lefthook wiring, killed-run detection, the daily aggregate,
 * rotation, and the SessionStart line.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHandFiles } from '../load.ts';
import { aggregateDays, rotateTimings } from '../local.ts';
import { machineReading } from '../machine.ts';
import type { LocalDay } from '../data.ts';
import { hookRuns, parseTimings } from '../timings.ts';
// @ts-expect-error -- plain .mjs, typed by its JSDoc, with no declaration file
import { lastRunKilled, sessionLine } from '../../bin/session-line.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const WRAP = path.join(REPO, 'packages', 'ci-steward', 'bin', 'time-wrap.sh');
const SHELLS = [
  '/bin/sh',
  '/bin/dash',
  '/bin/bash',
  '/bin/ksh',
  '/usr/bin/dash',
  '/usr/bin/bash',
].filter((s, i, all) => existsSync(s) && all.indexOf(s) === i);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ci-steward-wrap-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}

const timingsFile = (repo: string) => path.join(repo, '.git', 'ci-steward', 'local-timings.jsonl');

describe('bin/time-wrap.sh', () => {
  it.each(SHELLS)(
    'under %s: stdin and the exit status pass through, and START/END are written',
    (sh) => {
      const repo = gitRepo();
      const body = `. ${WRAP}; ci_steward_time_wrap pre-push tests\nread a b; echo "got:$a"; exit 7`;
      const r = spawnSync(sh, ['-c', body], {
        cwd: repo,
        input: 'refs/heads/x abc\n',
        encoding: 'utf8',
      });
      expect(r.stdout).toBe('got:refs/heads/x\n');
      expect(r.status).toBe(7);
      const events = parseTimings(readFileSync(timingsFile(repo), 'utf8'));
      expect(events.map((e) => [e.e, e.h, e.c, e.x])).toEqual([
        ['S', 'pre-push', 'tests', undefined],
        ['E', 'pre-push', 'tests', 7],
      ]);
      expect(events[0]!.id).toBe(events[1]!.id);
    }
  );

  it.each(
    SHELLS.flatMap((sh) =>
      (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map((sig) => [sh, sig] as const)
    )
  )('under %s, %s writes END with 128+n and exits with it', async (sh, sig) => {
    const repo = gitRepo();
    const child = spawn(sh, ['-c', `. ${WRAP}; ci_steward_time_wrap pre-push tests\nsleep 5`], {
      cwd: repo,
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(-child.pid!, sig);
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    const n = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig];
    expect(code).toBe(128 + n);
    expect(parseTimings(readFileSync(timingsFile(repo), 'utf8')).map((e) => [e.e, e.x])).toEqual([
      ['S', undefined],
      ['E', 128 + n],
    ]);
  });

  it('runs the hook untouched when the script is missing (the lefthook guard)', () => {
    const repo = gitRepo();
    const r = spawnSync(
      '/bin/sh',
      [
        '-c',
        `[ -r ${repo}/missing.sh ] && . ${repo}/missing.sh && ci_steward_time_wrap pre-push tests\necho ran; exit 4`,
      ],
      { cwd: repo, encoding: 'utf8' }
    );
    expect(r.stdout).toBe('ran\n');
    expect(r.status).toBe(4);
  });

  it('writes no END when the shell is killed with SIGKILL, which is how a killed run shows', () => {
    const repo = gitRepo();
    const r = spawnSync(
      '/bin/sh',
      ['-c', `. ${WRAP}; ci_steward_time_wrap pre-push tests\nkill -KILL $$`],
      { cwd: repo }
    );
    expect(r.signal).toBe('SIGKILL');
    expect(parseTimings(readFileSync(timingsFile(repo), 'utf8')).map((e) => e.e)).toEqual(['S']);
  });

  it('never fails or changes a hook: off by switch, and outside a git checkout', () => {
    const repo = gitRepo();
    const off = spawnSync(
      '/bin/sh',
      ['-c', `CI_STEWARD_TIMINGS=0\n. ${WRAP}; ci_steward_time_wrap pre-commit lint\nexit 3`],
      { cwd: repo }
    );
    expect(off.status).toBe(3);
    expect(existsSync(timingsFile(repo))).toBe(false);
    const bare = mkdtempSync(path.join(tmpdir(), 'ci-steward-nogit-'));
    dirs.push(bare);
    const outside = spawnSync(
      '/bin/sh',
      [
        '-c',
        `export GIT_CEILING_DIRECTORIES='${path.dirname(bare)}'\n. ${WRAP}; ci_steward_time_wrap pre-commit lint\necho ok`,
      ],
      { cwd: bare, encoding: 'utf8' }
    );
    expect(outside.stdout).toBe('ok\n');
    expect(outside.status).toBe(0);
  });

  it('writes to the file ci/config.yaml names', () => {
    const { files } = loadHandFiles(REPO);
    expect(readFileSync(WRAP, 'utf8')).toContain(`"$_cst_dir/${files!.config.local.timings_file}"`);
  });
});

describe('lefthook.yml wiring', () => {
  const doc = parseYaml(readFileSync(path.join(REPO, 'lefthook.yml'), 'utf8')) as Record<
    string,
    { commands?: Record<string, { run: string }> }
  >;
  const commands = Object.entries(doc).flatMap(([hook, cfg]) =>
    Object.entries(cfg?.commands ?? {}).map(([name, c]) => ({ hook, name, run: c.run }))
  );

  it('finds the commands', () => {
    // Five since typecheck left pre-commit (ci/ledger/260919-175506-*): four at
    // commit, one at push. It was six after DOR-2160 removed the pre-push test
    // gate. A floor rather than an equality, because adding a hook command is
    // ordinary and the thing this guards is the scanner silently matching
    // nothing — but the floor moves down with the file, or it stops guarding.
    expect(commands.length).toBeGreaterThanOrEqual(5);
  });

  it.each(commands.map((c) => [`${c.hook}.${c.name}`, c] as const))(
    '%s opens with the time-wrap naming itself',
    (_, c) => {
      expect(c.run.split('\n')[0]).toBe(
        `[ -r packages/ci-steward/bin/time-wrap.sh ] && . packages/ci-steward/bin/time-wrap.sh && ci_steward_time_wrap ${c.hook} ${c.name}`
      );
    }
  );
});

describe('hook runs from the timings file', () => {
  const ev = (e: 'S' | 'E', h: string, c: string, id: string, pp: number, t: number, x?: number) =>
    JSON.stringify({ v: 1, e, h, c, id, pp, t, ...(x === undefined ? {} : { x }) });
  const t0 = Date.parse('2026-09-18T10:00:00Z') / 1000;
  const text = [
    // A parallel pre-commit: three commands under one lefthook process.
    ev('S', 'pre-commit', 'format', '1-a', 50, t0),
    ev('S', 'pre-commit', 'lint', '2-a', 50, t0),
    ev('S', 'pre-commit', 'typecheck', '3-a', 50, t0 + 1),
    ev('E', 'pre-commit', 'format', '1-a', 50, t0 + 3, 0),
    ev('E', 'pre-commit', 'lint', '2-a', 50, t0 + 40, 0),
    ev('E', 'pre-commit', 'typecheck', '3-a', 50, t0 + 90, 1),
    // A piped pre-push whose test gate was killed at the ceiling.
    ev('S', 'pre-push', 'formatting', '4-b', 60, t0 + 200),
    ev('E', 'pre-push', 'formatting', '4-b', 60, t0 + 202, 0),
    ev('S', 'pre-push', 'tests', '5-b', 60, t0 + 202),
    'not json',
    // A pre-push still running now.
    ev('S', 'pre-push', 'formatting', '6-c', 70, t0 + 3000),
  ].join('\n');

  it('groups commands into hook runs and tells done, killed and still-open apart', () => {
    const runs = hookRuns(parseTimings(text), t0 + 3100, 600);
    expect(runs.map((r) => [r.hook, r.state, r.seconds, r.failed, r.commands.length])).toEqual([
      ['pre-commit', 'done', 90, true, 3],
      ['pre-push', 'killed', null, false, 2],
      ['pre-push', 'open', null, false, 1],
    ]);
  });

  it('aggregates finished days only, leaving an open run for the next export', () => {
    const runs = hookRuns(parseTimings(text), t0 + 3100, 600);
    const [day] = aggregateDays(runs, 'clone-x', '2026-09-19', '2026-09-19T01:00:00Z');
    expect(day!.hooks).toEqual({
      'pre-commit': { durations: [[36000, 90]], killed: 0, failed: 1, notes: {} },
      'pre-push': { durations: [], killed: 1, failed: 0, notes: {} },
    });
    expect(day!.commands['pre-push.tests']).toEqual({
      durations: [],
      killed: 1,
      failed: 0,
      notes: {},
    });
    expect(aggregateDays(runs, 'clone-x', '2026-09-18', 'x')).toEqual([]);
  });

  it('keeps a line appended while it rotates, so an END never goes missing', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ci-steward-rot-'));
    dirs.push(d);
    const f = path.join(d, 't.jsonl');
    const old = ev('S', 'pre-push', 'tests', '1', 1, t0 - 40 * 86_400);
    const start = ev('S', 'pre-push', 'tests', '9-z', 90, t0 + 50);
    writeFileSync(f, `${old}\n${start}\n`);
    const end = ev('E', 'pre-push', 'tests', '9-z', 90, t0 + 60, 0);
    rotateTimings(f, t0 + 100, 30, 1_000_000, () => appendFileSync(f, `${end}\n`));
    expect(readFileSync(f, 'utf8')).toBe(`${start}\n${end}\n`);
    expect(hookRuns(parseTimings(readFileSync(f, 'utf8')), t0 + 100_000, 600)[0]!.state).toBe(
      'done'
    );
  });

  it('rotates by age, then by size', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ci-steward-rot-'));
    dirs.push(d);
    const f = path.join(d, 't.jsonl');
    const old = ev('S', 'pre-push', 'tests', '1', 1, t0 - 40 * 86_400);
    writeFileSync(f, `${old}\n${text}\n`);
    expect(rotateTimings(f, t0 + 100, 30, 1_000_000)).toEqual({ kept: 10, dropped: 2 });
    expect(readFileSync(f, 'utf8')).not.toContain(`"t":${t0 - 40 * 86_400}`);
    expect(rotateTimings(f, t0 + 100, 30, 200).kept).toBe(5);
  });
});

describe('the SessionStart line', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const base = { timings: null, nowMs: now, ceilingSec: 7500, lastFetchMs: now - 3_600_000 };
  const latest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      date: '2026-09-18',
      collected_at: '2026-09-19T05:03:00Z',
      healthy: true,
      failures: [],
      local_breaches: [],
      safeguards_ok: true,
      ...over,
    });

  it('is silent when the ref is absent, or when everything is healthy', () => {
    expect(sessionLine({ ...base, latest: null })).toBeNull();
    expect(sessionLine({ ...base, latest: latest() })).toBeNull();
  });

  it('prints one [Harness] line naming every problem', () => {
    const line = sessionLine({
      ...base,
      latest: latest({
        collected_at: '2026-09-16T05:00:00Z',
        healthy: false,
        failures: ['x'],
        local_breaches: ['local-push'],
        safeguards_ok: false,
      }),
    })!;
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toMatch(/^\[Harness\] CI Steward: /);
    for (const s of [
      'the daily collector has stopped',
      'collector health failed',
      'safeguard ruleset',
      'local SLO breached: local-push',
    ])
      expect(line).toContain(s);
  });

  it('says "not fetched", not "stopped", when this checkout has an old copy', () => {
    const line = sessionLine({
      ...base,
      latest: latest({ collected_at: '2026-09-16T05:00:00Z' }),
      lastFetchMs: Date.parse('2026-09-16T08:00:00Z'),
    })!;
    expect(line).toContain('was not fetched in over 2 days');
    expect(line).not.toContain('stopped');
  });

  const ev = (e: 'S' | 'E', t: number, x?: number, c = 'tests') =>
    JSON.stringify({
      v: 1,
      e,
      h: 'pre-push',
      c,
      id: `1-${c}`,
      pp: 1,
      t,
      ...(x === undefined ? {} : { x }),
    });

  it('reports a hook stopped by a signal at once, or a START past the watchdog ceiling', () => {
    const t = now / 1000 - 120;
    const termed = [ev('S', t), ev('E', t + 30, 143)].join('\n');
    expect(sessionLine({ ...base, latest: null, timings: termed })).toContain(
      'last pre-push hook in this clone was killed'
    );
    const old = ev('S', now / 1000 - 7600);
    expect(sessionLine({ ...base, latest: null, timings: old })).toContain('was killed');
  });

  it('never calls a push that may still be running killed', () => {
    // Eleven minutes in: past the agent tool ceiling, well inside the watchdog's.
    const running = ev('S', now / 1000 - 660);
    expect(sessionLine({ ...base, latest: null, timings: running })).toBeNull();
  });

  it('agrees with hookRuns on which runs were killed', () => {
    const t = now / 1000 - 3000;
    const cases = [
      [ev('S', t), ev('E', t + 10, 0)],
      [ev('S', t), ev('E', t + 10, 1)],
      [ev('S', t), ev('E', t + 10, 130)],
      [ev('S', t, undefined, 'formatting'), ev('E', t + 2, 0, 'formatting'), ev('S', t + 2)],
      [ev('S', now / 1000 - 8000)],
    ];
    for (const lines of cases) {
      const text = lines.join('\n');
      const runs = hookRuns(parseTimings(text), now / 1000, 7500);
      const last = runs.at(-1)!;
      expect(lastRunKilled(text, now / 1000, 7500) !== null, text).toBe(last.state === 'killed');
    }
  });
});

/**
 * The machine the hooks ran on, and how a run ended (DOR-2160).
 *
 * These three things exist because a local SLO reads mostly as a fact about
 * somebody's box, and until this change nothing recorded the box: "my pushes
 * are slow" was a feeling for months while the operator machine sat at load 512
 * on 14 cores with 15.9 GB of a 17.4 GB swap file in use.
 *
 * The one that is easiest to lose and worst to lose is the third: a gate the
 * pre-push budget cut short PASSES, so its exit status is 0 and it is
 * indistinguishable from a gate that ran everything and was happy. That
 * indistinguishability is the only thing that would make passing on a timeout
 * dishonest, so the note that tells them apart is load-bearing.
 */
describe('the machine, and how a run ended', () => {
  const t0 = Date.parse('2026-09-18T10:00:00Z') / 1000;
  const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });

  it('reads load per core, memory and swap off the event lines', () => {
    const text = [
      line({
        e: 'S',
        h: 'pre-push',
        c: 'tests',
        id: '1',
        pp: 9,
        t: t0,
        l: 28,
        n: 14,
        m: 700,
        s: 15881,
      }),
      line({
        e: 'E',
        h: 'pre-push',
        c: 'tests',
        id: '1',
        pp: 9,
        t: t0 + 60,
        x: 0,
        l: 42,
        n: 14,
        m: 300,
        s: 16000,
      }),
    ].join('\n');
    const [run] = hookRuns(parseTimings(text), t0 + 1000, 600);
    expect(run!.machine).toEqual([
      { t: t0, loadPerCore: 2, memAvailableMb: 700, swapUsedMb: 15881 },
      { t: t0 + 60, loadPerCore: 3, memAvailableMb: 300, swapUsedMb: 16000 },
    ]);
  });

  it('calls a load average with no core count unknown rather than raw', () => {
    // A load of 28 means something different on 4 cores and on 64, so the ratio
    // is null rather than a number that would be compared across machines.
    const text = line({ e: 'S', h: 'pre-push', c: 'tests', id: '1', pp: 9, t: t0, l: 28, m: 700 });
    const [run] = hookRuns(parseTimings(text), t0 + 10_000, 600);
    expect(run!.machine[0]).toEqual({
      t: t0,
      loadPerCore: null,
      memAvailableMb: 700,
      swapUsedMb: null,
    });
  });

  it('tells a run that finished from one the OS took away', () => {
    const text = [
      line({ e: 'S', h: 'pre-commit', c: 'lint', id: 'a', pp: 10, t: t0 }),
      line({ e: 'E', h: 'pre-commit', c: 'lint', id: 'a', pp: 10, t: t0 + 5, x: 0 }),
      // SIGKILL runs no trap at all: a START with no END, past the ceiling.
      line({ e: 'S', h: 'pre-commit', c: 'lint', id: 'c', pp: 30, t: t0 + 200 }),
    ].join('\n');
    const runs = hookRuns(parseTimings(text), t0 + 5000, 600);
    expect(runs.map((r) => r.state)).toEqual(['done', 'killed']);
  });

  it('carries notes and machine readings into the day a clone exports', () => {
    const text = [
      line({
        e: 'S',
        h: 'pre-push',
        c: 'tests',
        id: 'a',
        pp: 10,
        t: t0,
        l: 28,
        n: 14,
        m: 700,
        s: 15881,
      }),
      line({ e: 'O', h: 'pre-push', c: 'tests', id: 'a', o: 'lock_timeout', d: 45, t: t0 + 1 }),
      line({ e: 'O', h: 'pre-push', c: 'tests', id: 'a', o: 'lock_wait', d: 30, t: t0 + 2 }),
      line({
        e: 'E',
        h: 'pre-push',
        c: 'tests',
        id: 'a',
        pp: 10,
        t: t0 + 121,
        x: 0,
        l: 30,
        n: 14,
        m: 500,
        s: 15900,
      }),
    ].join('\n');
    const runs = hookRuns(parseTimings(text), t0 + 5000, 600);
    const [day] = aggregateDays(runs, 'clone-x', '2026-09-19', '2026-09-19T01:00:00Z');
    expect(day!.commands['pre-push.tests']!.notes).toEqual({ lock_timeout: 1, lock_wait: 1 });
    // The hook's own bucket carries its commands' notes, so a reader asking
    // "how often did a gate run with no slot" never has to know the command name.
    expect(day!.hooks['pre-push']!.notes).toEqual({ lock_timeout: 1, lock_wait: 1 });
    expect(day!.machine).toEqual({
      load_per_core: [
        [36_000, 2],
        [36_121, 2.14],
      ],
      mem_available_mb: [
        [36_000, 700],
        [36_121, 500],
      ],
      swap_used_mb: [
        [36_000, 15_881],
        [36_121, 15_900],
      ],
    });
  });

  it('reads each machine statistic at its own bad end, and says null for what nobody measured', () => {
    // "The average was fine" is how a saturated machine hides, so load is p90
    // (the slow tail), memory p10 (the moment there was none) and swap p50
    // (sustained, because a spike is a program starting).
    const day = (over: Partial<NonNullable<LocalDay['machine']>>): LocalDay => ({
      schema: 1,
      clone: 'c',
      date: '2026-09-19',
      exported_at: 'x',
      hooks: {},
      commands: {},
      machine: { load_per_core: [], mem_available_mb: [], swap_used_mb: [], ...over },
    });
    const at = (xs: number[]) => xs.map((v, i) => [i, v] as [number, number]);
    const r = machineReading([
      day({
        load_per_core: at([1, 1, 1, 1, 1, 1, 1, 1, 30, 30]),
        mem_available_mb: at([80, 900, 900, 900, 900]),
      }),
    ]);
    // Eight quiet readings and two catastrophic ones: the mean is 6.8 and says
    // "busy", the p90 is 30 and says "this machine cannot do its job".
    expect(r.load_per_core_p90).toBe(30);
    expect(r.mem_available_mb_p10).toBeLessThan(500);
    expect(r.swap_used_mb_p50).toBeNull();
    expect(machineReading([]).n).toBe(0);
  });
});

/**
 * The heavy-run slot cap's numbers live in `ci/config.yaml`, and the script that
 * enforces them reads that file with `sed` because it runs before any
 * node_modules exist. It also carries hardcoded fallbacks for a checkout where
 * that read fails.
 *
 * A fallback that disagrees with the config is the worst kind of drift: nothing
 * fails, the cap just quietly becomes a different number than the one the ledger
 * entry argued for. Same reasoning as the `timings_file` pin above.
 */
describe('the heavy-run lock agrees with ci/config.yaml', () => {
  const script = readFileSync(path.join(REPO, 'scripts', 'heavy-run-lock.sh'), 'utf8');
  const { files } = loadHandFiles(REPO);

  it.each([
    ['SLOTS', 'heavy_run_slots'],
    ['WAIT_SECONDS', 'heavy_lock_wait_seconds'],
    ['MAX_HOLD_SECONDS', 'heavy_lock_max_hold_seconds'],
  ] as const)('%s falls back to the configured %s', (variable, key) => {
    const fallback = new RegExp(`^${variable}="\\$\\{${variable}:-(\\d+)\\}"$`, 'm').exec(script);
    expect(fallback, `heavy-run-lock.sh has no literal fallback for ${variable}`).not.toBeNull();
    expect(Number(fallback![1])).toBe(files!.config.local[key]);
  });

  it('reads the config keys it claims to read', () => {
    // The sed expression takes the key name as an argument, so a renamed key
    // would silently fall back rather than fail.
    for (const key of ['heavy_run_slots', 'heavy_lock_wait_seconds', 'heavy_lock_max_hold_seconds'])
      expect(script).toContain(`config_number ${key}`);
  });
});

/**
 * A hook run's notes are counted once per RUN, its commands' once per COMMAND.
 *
 * `ci/metrics.yaml` declares `tracked.gate-cut-short` a share of hook runs, and
 * one run can leave two `lock_timeout` notes when two of its commands wait for
 * a slot. The fixture is the real case: pre-commit `lint` and `typecheck` both
 * held slots until typecheck left the hook on 2026-09-24
 * (ci/ledger/260919-175506-*), and those records are still in the file. Summing
 * them into the hook bucket made a numerator that could exceed its denominator,
 * and the daily report printed "Of 1 hook runs ... 2 ran without waiting for a
 * free slot" — a number that cannot happen, on the one surface a person reads.
 */
describe('note counting has the right denominator', () => {
  const t0 = Date.parse('2026-09-18T10:00:00Z') / 1000;
  const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });

  it('counts one contended pre-commit as one run, not two', () => {
    const cmd = (c: string, id: string) => [
      line({ e: 'S', h: 'pre-commit', c, id, pp: 77, t: t0 }),
      line({ e: 'O', h: 'pre-commit', c, id, o: 'lock_timeout', d: 45, t: t0 + 45 }),
      line({ e: 'E', h: 'pre-commit', c, id, pp: 77, t: t0 + 200, x: 0 }),
    ];
    const text = [...cmd('lint', 'a'), ...cmd('typecheck', 'b')].join('\n');
    const runs = hookRuns(parseTimings(text), t0 + 5000, 600);
    expect(runs).toHaveLength(1);
    const [day] = aggregateDays(runs, 'clone-x', '2026-09-19', 'x');

    // One run, so the hook's count is 1 even though two commands recorded it.
    expect(day!.hooks['pre-commit']!.durations).toHaveLength(1);
    expect(day!.hooks['pre-commit']!.notes).toEqual({ lock_timeout: 1 });

    // The per-command buckets keep the full tally: both commands really waited.
    expect(day!.commands['pre-commit.lint']!.notes).toEqual({ lock_timeout: 1 });
    expect(day!.commands['pre-commit.typecheck']!.notes).toEqual({ lock_timeout: 1 });
  });

  it('never lets the numerator exceed the denominator', () => {
    // The property the report depends on, asserted directly rather than via the
    // one arrangement above: a share over hook runs must be at most 1.
    const cmds = ['lint', 'typecheck', 'format'].flatMap((c, i) => [
      line({ e: 'S', h: 'pre-commit', c, id: `x${i}`, pp: 88, t: t0 }),
      line({ e: 'O', h: 'pre-commit', c, id: `x${i}`, o: 'lock_timeout', d: 45, t: t0 + 1 }),
      line({ e: 'E', h: 'pre-commit', c, id: `x${i}`, pp: 88, t: t0 + 10, x: 0 }),
    ]);
    const [day] = aggregateDays(
      hookRuns(parseTimings(cmds.join('\n')), t0 + 5000, 600),
      'c',
      '2026-09-19',
      'x'
    );
    const h = day!.hooks['pre-commit']!;
    expect(h.notes!.lock_timeout).toBeLessThanOrEqual(h.durations.length + h.killed);
  });
});
