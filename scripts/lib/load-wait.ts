/**
 * A bare root `vitest run` waits for the load (DOR-4646).
 *
 * `pnpm test` and the test step of `pnpm verify` already wait for the load
 * through `scripts/heavy-run-lock.sh --tests`. A bare `pnpm vitest run` from
 * the repo root goes through neither: it loads the root `vitest.config.ts`,
 * which registers this file as its `globalSetup`. Vitest runs the root
 * project's global setup once, in the main process, after it has read the
 * command line and before any test starts, so this is the earliest point where
 * the run's file filters are known.
 *
 * The rule is the lock's, with the same numbers from `ci/config.yaml`:
 *
 *   * ONE path on the command line is a single-file run and never waits. That
 *     is the targeted loop AGENTS.md prescribes, and it is cheap.
 *   * No path (the whole workspace) or more than one waits while the 1-minute
 *     load is over `local.heavy_test_max_load` (16), printing `waiting for
 *     load`, re-reading every `local.heavy_load_poll_seconds` (30 s).
 *   * Still over after `local.heavy_load_wait_seconds` (600 s): the run fails
 *     before any test starts, saying so. A wait that can last forever is a
 *     wait that gets bypassed, which is the lock's reason too.
 *   * Never under `CI`, never inside a run that already holds a heavy slot
 *     (`DORKOS_HEAVY_SLOT_HELD`, so `pnpm test` does not wait twice), and a
 *     load that cannot be read lets the run through.
 *   * `DORKOS_IGNORE_LOAD=1` (or `DORKOS_HEAVY_LOCK=0`, which switches the
 *     whole lock off) skips it, and says so.
 *
 * What still bypasses it: a package's own config (`pnpm --filter <pkg> test`,
 * or `vitest` run inside a package directory), and `vitest run --config
 * <other>`. Those load no root config. One path that is a DIRECTORY counts as
 * a single-file run here; the filter is all vitest gives a global setup.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What one call decided, for the caller and the tests. */
export type LoadWaitVerdict =
  'single-file' | 'ci' | 'nested' | 'ignored' | 'unreadable' | 'under' | 'waited' | 'overloaded';

/** Everything {@link waitForLoad} reads from the world, so tests can fake all of it. */
export interface LoadWaitOptions {
  /** The run's file filters: `undefined` or empty for a whole-workspace run. */
  filters: readonly string[] | undefined;
  /** The environment to read `CI` and the overrides from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The 1-minute load average, or `undefined` when it cannot be read. */
  readLoad: () => number | undefined;
  /** Wait while the load is over this. */
  maxLoad: number;
  /** Seconds between readings. */
  pollSeconds: number;
  /** Seconds to wait before giving up. */
  waitSeconds: number;
  /** Where the one-line messages go. */
  log: (line: string) => void;
  /** Sleeps for a number of milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** The current time in milliseconds. */
  now: () => number;
}

const TAG = '[load-wait]';

/**
 * Wait while the load is too high for a multi-file test run, or decide it need not.
 *
 * @param o - The run's filters, environment, load reader, numbers and clock.
 * @returns What it decided. `overloaded` means the caller should fail the run.
 */
export async function waitForLoad(o: LoadWaitOptions): Promise<LoadWaitVerdict> {
  if ((o.filters?.length ?? 0) === 1) return 'single-file';
  const ci = o.env.CI;
  if (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') return 'ci';
  if (o.env.DORKOS_HEAVY_SLOT_HELD) return 'nested';
  if (o.env.DORKOS_IGNORE_LOAD === '1' || o.env.DORKOS_HEAVY_LOCK === '0') {
    const which = o.env.DORKOS_IGNORE_LOAD === '1' ? 'DORKOS_IGNORE_LOAD=1' : 'DORKOS_HEAVY_LOCK=0';
    o.log(`${TAG} ${which} — not waiting for load on this run.`);
    return 'ignored';
  }

  let load = o.readLoad();
  if (load === undefined) return 'unreadable';
  if (load <= o.maxLoad) return 'under';

  const start = o.now();
  const deadline = start + o.waitSeconds * 1000;
  let lastSaid = -Infinity;
  while (load !== undefined && load > o.maxLoad) {
    const left = deadline - o.now();
    if (left <= 0) {
      o.log(
        `${TAG} the load is ${load.toFixed(2)}, over the max of ${o.maxLoad}, after waiting ` +
          `${Math.round((o.now() - start) / 1000)}s — not starting this multi-file run. ` +
          'Try again later, run one file, or set DORKOS_IGNORE_LOAD=1.'
      );
      return 'overloaded';
    }
    if (o.now() - lastSaid >= 60_000) {
      o.log(
        `${TAG} waiting for load: it is ${load.toFixed(2)}, over the max of ${o.maxLoad} — ` +
          `up to ${Math.round(left / 1000)}s more.`
      );
      lastSaid = o.now();
    }
    await o.sleep(Math.min(o.pollSeconds * 1000, left));
    load = o.readLoad();
  }
  return 'waited';
}

/**
 * The fallbacks for when `ci/config.yaml` cannot be read. Pinned to the config
 * by `scripts/__tests__/load-wait.test.ts`, as the lock's are by local.test.ts.
 */
export const FALLBACKS = {
  heavy_test_max_load: 16,
  heavy_load_wait_seconds: 600,
  heavy_load_poll_seconds: 30,
} as const;

/**
 * Read one `local.<key>: <number>` line from `ci/config.yaml`, the same way the
 * lock's `sed` does, or the fallback when it cannot.
 *
 * @param configText - The file's text, or `undefined` when it could not be read.
 * @param key - The key under `local:`.
 */
export function configNumber(configText: string | undefined, key: keyof typeof FALLBACKS): number {
  const m =
    configText === undefined ? null : new RegExp(`^  ${key}: *(\\d+)`, 'm').exec(configText);
  return m ? Number(m[1]) : FALLBACKS[key];
}

/** A positive number from the environment, or `undefined`. */
function envNumber(value: string | undefined): number | undefined {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Vitest global setup for the root project: waits for the load before a
 * whole-workspace or multi-file run, and fails the run if it never drops.
 *
 * @param project - The root test project; only its `vitest.filenamePattern` is read.
 */
export default async function setup(project: {
  vitest: { filenamePattern?: string[] | undefined };
}): Promise<void> {
  let configText: string | undefined;
  try {
    configText = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'ci', 'config.yaml'),
      'utf8'
    );
  } catch {
    configText = undefined;
  }
  const env = process.env;
  const verdict = await waitForLoad({
    filters: project.vitest.filenamePattern,
    env,
    readLoad: () => {
      const one = os.loadavg()[0];
      return one === undefined || !Number.isFinite(one) ? undefined : one;
    },
    maxLoad:
      envNumber(env.DORKOS_HEAVY_TEST_MAX_LOAD) ?? configNumber(configText, 'heavy_test_max_load'),
    pollSeconds:
      envNumber(env.DORKOS_HEAVY_LOAD_POLL_SECONDS) ??
      configNumber(configText, 'heavy_load_poll_seconds'),
    waitSeconds:
      envNumber(env.DORKOS_HEAVY_LOAD_WAIT_SECONDS) ??
      configNumber(configText, 'heavy_load_wait_seconds'),
    log: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
  if (verdict === 'overloaded') {
    throw new Error('the machine is too busy for a multi-file test run (see the line above)');
  }
}
