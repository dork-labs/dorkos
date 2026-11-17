/**
 * A bare root `vitest run` waits for the load; one file and CI never do (DOR-4646).
 *
 * Every case fakes the load, the clock and the sleep: this machine's real load
 * must never decide a case, and a real 30 s poll has no place in a unit test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FALLBACKS, configNumber, waitForLoad, type LoadWaitOptions } from '../lib/load-wait.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** A fake world: loads are read in order, the last one repeats; sleeping moves the clock. */
function world(loads: (number | undefined)[], over: Partial<LoadWaitOptions> = {}) {
  let t = 0;
  let i = 0;
  const lines: string[] = [];
  const sleeps: number[] = [];
  const options: LoadWaitOptions = {
    filters: undefined,
    env: {},
    readLoad: () => loads[Math.min(i++, loads.length - 1)],
    maxLoad: 16,
    pollSeconds: 30,
    waitSeconds: 600,
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    ...over,
  };
  return { options, lines, sleeps, reads: () => i };
}

describe('waitForLoad', () => {
  it('waits while the load is over 16, says so, then runs once it drops', async () => {
    const w = world([30, 20, 12]);
    expect(await waitForLoad(w.options)).toBe('waited');
    expect(w.sleeps).toEqual([30_000, 30_000]);
    expect(w.lines.some((l) => l.includes('waiting for load') && l.includes('30.00'))).toBe(true);
  });

  it('runs at once at exactly 16 and under it', async () => {
    for (const load of [16, 3.5]) {
      const w = world([load]);
      expect(await waitForLoad(w.options)).toBe('under');
      expect(w.sleeps).toEqual([]);
      expect(w.lines).toEqual([]);
    }
  });

  it('waits for more than one path too', async () => {
    const w = world([40, 1], { filters: ['apps/server', 'packages/relay'] });
    expect(await waitForLoad(w.options)).toBe('waited');
  });

  it('never holds a single-file run, and never reads the load for one', async () => {
    const w = world([99], { filters: ['apps/server/src/foo.test.ts'] });
    expect(await waitForLoad(w.options)).toBe('single-file');
    expect(w.reads()).toBe(0);
  });

  it.each(['true', '1'])('never holds a run under CI=%s', async (ci) => {
    const w = world([99], { env: { CI: ci } });
    expect(await waitForLoad(w.options)).toBe('ci');
    expect(w.reads()).toBe(0);
  });

  it('treats CI=false as local', async () => {
    const w = world([99, 1], { env: { CI: 'false' } });
    expect(await waitForLoad(w.options)).toBe('waited');
  });

  it('does not wait inside a run that already holds a heavy slot', async () => {
    const w = world([99], { env: { DORKOS_HEAVY_SLOT_HELD: '1' } });
    expect(await waitForLoad(w.options)).toBe('nested');
  });

  it.each([
    ['DORKOS_IGNORE_LOAD', '1'],
    ['DORKOS_HEAVY_LOCK', '0'],
  ])('%s=%s skips the wait and says so', async (name, value) => {
    const w = world([99], { env: { [name]: value } });
    expect(await waitForLoad(w.options)).toBe('ignored');
    expect(w.reads()).toBe(0);
    expect(w.lines).toEqual([expect.stringContaining(`${name}=${value}`)]);
  });

  it('gives up after the wait bound and says how to get past it', async () => {
    const w = world([41.37], { waitSeconds: 90 });
    expect(await waitForLoad(w.options)).toBe('overloaded');
    // 30 + 30 + 30, then the bound is spent: no fourth sleep.
    expect(w.sleeps).toEqual([30_000, 30_000, 30_000]);
    const last = w.lines.at(-1) ?? '';
    expect(last).toContain('41.37');
    expect(last).toContain('DORKOS_IGNORE_LOAD=1');
  });

  it('says it is waiting at most once a minute', async () => {
    const w = world([30], { waitSeconds: 300, pollSeconds: 15 });
    await waitForLoad(w.options);
    expect(w.lines.filter((l) => l.includes('waiting for load'))).toHaveLength(5);
  });

  it('lets the run through when the load cannot be read', async () => {
    const w = world([undefined]);
    expect(await waitForLoad(w.options)).toBe('unreadable');
  });
});

describe('the numbers agree with ci/config.yaml', () => {
  const config = readFileSync(path.join(repoRoot, 'ci', 'config.yaml'), 'utf8');

  it.each(Object.keys(FALLBACKS) as (keyof typeof FALLBACKS)[])(
    'the %s fallback is the configured value',
    (key) => {
      const m = new RegExp(`^  ${key}: *(\\d+)`, 'm').exec(config);
      expect(m, `ci/config.yaml has no local.${key}`).not.toBeNull();
      expect(FALLBACKS[key]).toBe(Number(m![1]));
      expect(configNumber(config, key)).toBe(Number(m![1]));
    }
  );

  it('falls back when the config cannot be read', () => {
    expect(configNumber(undefined, 'heavy_test_max_load')).toBe(16);
  });
});

describe('the entry points are wired', () => {
  it('the root vitest config runs the wait as its global setup', () => {
    const text = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
    expect(text).toContain("globalSetup: ['scripts/lib/load-wait.ts']");
  });

  it.each(['test', 'verify:checks'])(
    'the root `%s` script runs its tests through --tests',
    (name) => {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts[name]).toMatch(/heavy-run-lock\.sh --tests [^&]*turbo (run )?test/);
    }
  );
});
