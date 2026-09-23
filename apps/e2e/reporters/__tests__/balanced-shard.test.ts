import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildTimings,
  load,
  partition,
  weighUnits,
  type ShardTimings,
  type ShardUnit,
  type WeightedUnit,
} from '../balanced-shard';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

function timings(units: ShardTimings['units']): ShardTimings {
  return { source: { generated: '2026-09-23', runs: ['1'] }, units };
}

function unit(key: string, weight: number): WeightedUnit {
  return { key, project: key.split('|')[0], tests: 1, weight, basis: 'measured' };
}

describe('weighUnits', () => {
  const t = timings({
    'chromium|a.spec.ts': { seconds: 30, tests: 3 },
    'chromium|b.spec.ts': { seconds: 10, tests: 1 },
    'mock|m.spec.ts': { seconds: 120, tests: 2 },
    'chromium|auth.spec.ts': { seconds: 0, tests: 2 },
  });

  it('scales a known unit by its own per-test rate when its test count changes', () => {
    const [u] = weighUnits([{ key: 'chromium|a.spec.ts', project: 'chromium', tests: 6 }], t);
    expect(u).toMatchObject({ weight: 60, basis: 'measured' });
  });

  it("weighs a new spec at its project's per-test rate, not at one test's worth", () => {
    const units: ShardUnit[] = [
      { key: 'mock|new.spec.ts', project: 'mock', tests: 4 },
      { key: 'chromium|new.spec.ts', project: 'chromium', tests: 4 },
    ];
    const [mock, chromium] = weighUnits(units, t);
    expect(mock).toMatchObject({ weight: 240, basis: 'project' });
    // chromium: 40 s over 6 tests, the auth spec's measured zero included.
    expect(chromium.weight).toBeCloseTo((40 / 6) * 4);
    expect(chromium.basis).toBe('project');
  });

  it('weighs a new project at the whole suite rate', () => {
    const [u] = weighUnits([{ key: 'fresh|x.spec.ts', project: 'fresh', tests: 2 }], t);
    expect(u.basis).toBe('suite');
    expect(u.weight).toBeCloseTo((160 / 8) * 2);
  });

  it('keeps a measured zero at zero', () => {
    const [u] = weighUnits([{ key: 'chromium|auth.spec.ts', project: 'chromium', tests: 2 }], t);
    expect(u).toMatchObject({ weight: 0, basis: 'measured' });
  });

  it("falls back to Playwright's count-based weighting with no timings at all", () => {
    const [u] = weighUnits(
      [{ key: 'chromium|a.spec.ts', project: 'chromium', tests: 5 }],
      undefined
    );
    expect(u).toMatchObject({ weight: 5, basis: 'count' });
  });
});

describe('partition', () => {
  const units = Array.from({ length: 40 }, (_, i) => unit(`p|f${i}.spec.ts`, ((i * 37) % 23) + 1));

  it('places every unit in exactly one shard', () => {
    const shards = partition(units, 3);
    const placed = shards.flat().map((u) => u.key);
    expect(placed).toHaveLength(units.length);
    expect(new Set(placed)).toEqual(new Set(units.map((u) => u.key)));
  });

  it('gives every shard the same answer whatever order the units arrive in', () => {
    const forward = partition(units, 3).map((s) => s.map((u) => u.key).sort());
    const reversed = partition([...units].reverse(), 3).map((s) => s.map((u) => u.key).sort());
    expect(reversed).toEqual(forward);
  });

  it('keeps shards within one unit of each other', () => {
    const loads = partition(units, 3).map(load);
    const heaviest = Math.max(...units.map((u) => u.weight));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(heaviest);
  });

  it('breaks weight ties by key, never by position', () => {
    const tied = [unit('p|b', 5), unit('p|a', 5), unit('p|c', 5)];
    expect(partition(tied, 3).map((s) => s.map((u) => u.key))).toEqual([['p|a'], ['p|b'], ['p|c']]);
  });

  it('refuses a duplicate unit rather than running it twice', () => {
    expect(() => partition([unit('p|a', 1), unit('p|a', 2)], 2)).toThrow(/duplicate/);
  });

  it('refuses a nonsensical shard total', () => {
    expect(() => partition(units, 0)).toThrow(/positive integer/);
  });
});

describe('buildTimings', () => {
  const report = (seconds: number) => ({
    suites: [
      {
        file: 'chat-mock.spec.ts',
        suites: [
          {
            // A registered module's describe carries its own file; the unit is still the spec.
            file: 'chat/held-process.ts',
            specs: [
              { tests: [{ projectName: 'mock', results: [{ duration: seconds * 1000 }] }] },
              {
                tests: [{ projectName: 'mock', results: [{ duration: 1000 }, { duration: 1000 }] }],
              },
            ],
          },
        ],
      },
    ],
  });

  it('keys units by the loaded spec and takes the median run, retries included', () => {
    const t = buildTimings(
      [
        { id: 'r1', reports: [report(10)] },
        { id: 'r2', reports: [report(50)] },
        { id: 'r3', reports: [report(20)] },
      ],
      '2026-09-23'
    );
    expect(t.source.runs).toEqual(['r1', 'r2', 'r3']);
    expect(t.units).toEqual({ 'mock|chat-mock.spec.ts': { seconds: 22, tests: 2 } });
  });
});

describe('the reporter inside a real Playwright run', () => {
  it('runs every test exactly once across the shards, whole files at a time', () => {
    // Under this package so the fixture resolves its own Playwright install.
    const fixture = mkdtempSync(resolve(here, '../../.shard-proof-'));
    try {
      const spec = (name: string, count: number, serial = false) =>
        writeFileSync(
          join(fixture, name),
          `import { test, expect } from '@playwright/test';
           ${serial ? "test.describe.configure({ mode: 'serial' }); let ready = false; test.beforeAll(() => { ready = true; });" : ''}
           ${Array.from({ length: count }, (_, i) => `test('${name} ${i}', () => expect(${serial ? 'ready' : 'true'}).toBe(true));`).join('\n')}`
        );
      spec('heavy.spec.ts', 2);
      spec('medium.spec.ts', 3, true);
      spec('light-a.spec.ts', 4);
      spec('light-b.spec.ts', 4);
      spec('unmeasured.spec.ts', 2);
      writeFileSync(
        join(fixture, 'timings.json'),
        JSON.stringify(
          timings({
            'fast|heavy.spec.ts': { seconds: 600, tests: 2 },
            'fast|medium.spec.ts': { seconds: 300, tests: 3 },
            'fast|light-a.spec.ts': { seconds: 40, tests: 4 },
            'fast|light-b.spec.ts': { seconds: 40, tests: 4 },
            'slow|heavy.spec.ts': { seconds: 900, tests: 2 },
          })
        )
      );
      writeFileSync(
        join(fixture, 'playwright.config.ts'),
        `export default {
           testDir: '.', workers: 1, retries: 0, fullyParallel: true,
           projects: [{ name: 'fast' }, { name: 'slow', testMatch: 'heavy.spec.ts' }],
           reporter: [
             ['json', { outputFile: process.env.OUT }],
             [${JSON.stringify(resolve(here, '../balanced-shard-reporter.ts'))}, { timings: './timings.json' }],
           ],
         };`
      );
      const run = (args: string[], out: string) =>
        spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.config.ts', ...args], {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
            HOME: fixture,
            USERPROFILE: fixture,
            SystemRoot: process.env.SystemRoot,
            OUT: join(fixture, out),
          },
        });

      type Report = {
        config: { shard: { current: number; total: number } | null };
        suites: Array<{
          file: string;
          specs: Array<{ title: string; tests: Array<{ projectName: string; status: string }> }>;
        }>;
      };
      const ids = (file: string) => {
        const report = JSON.parse(readFileSync(join(fixture, file), 'utf8')) as Report;
        return {
          shard: report.config.shard,
          tests: report.suites.flatMap((s) =>
            s.specs.flatMap((sp) =>
              sp.tests.map((t) => ({
                id: `${t.projectName}|${s.file}|${sp.title}`,
                status: t.status,
              }))
            )
          ),
        };
      };

      const whole = run([], 'whole.json');
      expect(whole.status, whole.stdout + whole.stderr).toBe(0);
      expect(whole.stdout).not.toContain('balanced shard');
      const all = ids('whole.json')
        .tests.map((t) => t.id)
        .sort();
      expect(all).toHaveLength(17);

      const shards = [1, 2, 3].map((i) => {
        const r = run([`--shard=${i}/3`], `shard-${i}.json`);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain(`balanced shard ${i}/3`);
        return ids(`shard-${i}.json`);
      });

      // The shard stays recorded, so the fan-in's shard-set check still reads it.
      expect(shards.map((s) => s.shard)).toEqual(
        [1, 2, 3].map((current) => ({ current, total: 3 }))
      );
      // Every test ran exactly once across the shards — and passed, so the
      // serial file's beforeAll ran in the same shard as its tests.
      const union = shards.flatMap((s) => s.tests);
      expect(union.map((t) => t.id).sort()).toEqual(all);
      expect(union.every((t) => t.status === 'expected')).toBe(true);
      // Whole files: no (project, file) unit is split between shards.
      const home = new Map<string, number>();
      shards.forEach((s, i) =>
        s.tests.forEach(({ id }) => {
          const u = id.split('|').slice(0, 2).join('|');
          expect(home.get(u) ?? i).toBe(i);
          home.set(u, i);
        })
      );
      // Duration, not count: the 900 s and 600 s units open separate shards.
      expect(home.get('slow|heavy.spec.ts')).not.toBe(home.get('fast|heavy.spec.ts'));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);
});
