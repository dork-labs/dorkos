import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { balance, readDurations } from '../balance.ts';
import DurationSequencer from '../sequencer.ts';

const root = resolve(import.meta.dirname, '../../..');
const temp: string[] = [];
const measuredAt = '2026-11-03T20:03:42.313Z';
const asOf = Date.parse('2026-11-04T00:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Make an isolated, entirely fabricated duration file. */
function snapshot(contents: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'dorkos-duration-'));
  temp.push(dir);
  const file = resolve(dir, 'durations.json');
  writeFileSync(file, contents);
  return file;
}

describe('duration snapshot fallback', () => {
  it('accepts fresh measurements but refuses missing, stale, future and malformed data', () => {
    const valid = { version: 1, measuredAt, durations: { 'apps/server/a.test.ts': 3000 } };
    const file = snapshot(JSON.stringify(valid));
    expect(readDurations(file, asOf)).toEqual(valid.durations);
    expect(readDurations(`${file}-missing`, asOf)).toBeNull();
    expect(readDurations(file, asOf + 31 * 86400000)).toBeNull();
    expect(readDurations(file, asOf - 86400000)).toBeNull();
    expect(readDurations(file, NaN)).toBeNull();
    for (const bad of [
      '{',
      'null',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, durations: {} }),
      JSON.stringify({ ...valid, durations: { 'apps/server/a.test.ts': -1 } }),
    ]) {
      expect(readDurations(snapshot(bad), asOf)).toBeNull();
    }
  });

  it('uses the installed Vitest hash/count split exactly when the snapshot is stale or the epoch is missing', async () => {
    const files = Array.from({ length: 19 }, (_, i) => ({
      moduleId: resolve(root, `apps/server/fake-${i}.test.ts`),
    })) as TestSpecification[];
    for (const epoch of ['', String(Date.parse('2030-01-01') / 1000)]) {
      vi.stubEnv('VITEST_SHARD_EPOCH', epoch);
      for (let index = 1; index <= 6; index++) {
        const ctx = { config: { root, shard: { index, count: 6 } } } as Vitest;
        expect(await new DurationSequencer(ctx).shard(files)).toEqual(
          await new BaseSequencer(ctx).shard(files)
        );
      }
    }
  });
});

describe('duration partition', () => {
  const durations = {
    'apps/server/a': 9000,
    'apps/server/b': 8000,
    'apps/server/c': 7000,
    'apps/server/d': 6000,
    'apps/server/e': 5000,
    'apps/server/f': 4000,
  };

  it('balances a skewed workload and is independent of collection order', () => {
    const items = Object.keys(durations).map((key) => ({ key }));
    const bins = balance(items, 3, durations);
    expect(bins.map((bin) => bin.ms)).toEqual([13000, 13000, 13000]);
    expect(balance([...items].reverse(), 3, durations)).toEqual(bins);
  });

  it.each([2, 6])('includes a new unmeasured file exactly once across %i shards', (count) => {
    const items = [...Object.keys(durations), 'apps/server/new'].map((key) => ({ key }));
    const bins = balance(items, count, durations);
    const keys = bins.flatMap((bin) => bin.items.map(({ key }) => key));
    expect(keys.sort()).toEqual(items.map(({ key }) => key).sort());
    expect(new Set(keys).size).toBe(items.length);
    expect(bins.reduce((sum, bin) => sum + bin.ms, 0)).toBe(46000);
    expect(items).toHaveLength(7);
  });

  it('covers empty and entirely new packages, with fewer files than shards', () => {
    expect(balance([], 6, {})).toHaveLength(6);
    const bins = balance([{ key: 'packages/new/a' }], 6, {});
    expect(bins.flatMap((bin) => bin.items)).toEqual([{ key: 'packages/new/a' }]);
    expect(bins.reduce((sum, bin) => sum + bin.ms, 0)).toBe(1000);
  });

  it.each(['vitest.config.ts', 'vite.config.ts'])(
    'loads %s through the real CLI and partitions all fixture files once',
    (configName) => {
      // Under the repo only for vitest module resolution; all content is invented.
      const dir = mkdtempSync(resolve(root, 'scripts/.duration-fixture-'));
      temp.push(dir);
      writeFileSync(
        resolve(dir, configName),
        `export default () => ({ test: { include: ['*.test.ts'], exclude: ['excluded.test.ts'], globals: true, setupFiles: ['./setup.ts'] } });`
      );
      writeFileSync(resolve(dir, 'setup.ts'), 'globalThis.fixtureReady = true;');
      writeFileSync(resolve(dir, 'excluded.test.ts'), "throw new Error('exclude lost');");
      for (let i = 0; i < 7; i++)
        writeFileSync(
          resolve(dir, `fake-${i}.test.ts`),
          "it('fixture', () => { expect(globalThis.fixtureReady).toBe(true); });"
        );
      const collected: string[] = [];
      for (let index = 1; index <= 6; index++) {
        const result = spawnSync(
          process.execPath,
          [
            resolve(root, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--maxWorkers=1',
            '--passWithNoTests',
            '--reporter=json',
            '--outputFile=report.json',
            '--config',
            resolve(root, 'scripts/sharding/config.ts'),
            '--root',
            dir,
            `--shard=${index}/6`,
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, VITEST_SHARD_EPOCH: String(asOf / 1000) },
          }
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const report = JSON.parse(readFileSync(resolve(dir, 'report.json'), 'utf8'));
        collected.push(...report.testResults.map((test: { name: string }) => test.name));
      }
      expect(collected).toHaveLength(7);
      expect(new Set(collected).size).toBe(7);
    },
    60000
  );

  it('uses known measurements through the actual sequencer', async () => {
    const data = JSON.parse(readFileSync(resolve(root, 'scripts/sharding/durations.json'), 'utf8'));
    vi.stubEnv('VITEST_SHARD_EPOCH', String((Date.parse(data.measuredAt) + 86400000) / 1000));
    const keys = Object.keys(data.durations)
      .filter((key) => key.startsWith('apps/server/'))
      .slice(0, 41);
    const files = keys.map((key) => ({ moduleId: resolve(root, key) })) as TestSpecification[];
    const expected = balance(
      keys.map((key) => ({ key })),
      6,
      data.durations
    );
    for (let index = 1; index <= 6; index++) {
      const ctx = { config: { root, shard: { index, count: 6 } } } as Vitest;
      const selected = await new DurationSequencer(ctx).shard([...files].reverse());
      expect(selected.map((spec) => spec.moduleId)).toEqual(
        expected[index - 1]!.items.map(({ key }) => resolve(root, key))
      );
    }
  });

  it('hashes the snapshot, sequencer and common age decision into every turbo test key', () => {
    const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8'));
    expect(turbo.globalPassThroughEnv).toContain('VITEST_SHARD_EPOCH');
    for (const [key, task] of Object.entries(turbo.tasks) as [
      string,
      { inputs?: string[]; env?: string[] },
    ][]) {
      if (key === 'test' || key.endsWith('#test')) {
        expect(task.inputs).toContain('$TURBO_ROOT$/scripts/sharding/**');
        expect(task.env).toContain('VITEST_SHARD_MODE');
      }
    }
    const workflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');
    expect(workflow.match(/--config=\.\.\/\.\.\/scripts\/sharding\/config.ts/g)).toHaveLength(2);
    expect(workflow).toContain('epoch=$(git show -s --format=%ct HEAD)');
    expect(workflow).toContain('node scripts/sharding/mode.mjs');
  });
});
