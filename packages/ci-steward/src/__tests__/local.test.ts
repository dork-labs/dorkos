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
    expect(commands.length).toBeGreaterThanOrEqual(7);
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
      'pre-commit': { durations: [[36000, 90]], killed: 0, failed: 1 },
      'pre-push': { durations: [], killed: 1, failed: 0 },
    });
    expect(day!.commands['pre-push.tests']).toEqual({ durations: [], killed: 1, failed: 0 });
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
