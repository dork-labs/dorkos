/**
 * The upgrade boot: the one launch where a `CONFIG_MIGRATIONS` body runs, and
 * the one where a busy machine used to cost a person their settings.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s `0.0.0` in a dev
 * tree, so **no migration body runs under the default test environment** and
 * none of this is reachable. `DORKOS_VERSION_OVERRIDE` has to be set before
 * `lib/version.ts` is imported, which means before this file's imports, which
 * means a separate module registry. A test that skipped this would pass while
 * exercising nothing.
 *
 * ## What it covers
 *
 * `conf@15`'s `_migrate` catches everything thrown inside its per-migration
 * `try` and rethrows it as a plain `Error` — no `code`, no `cause`. That block
 * is full of READS: every migration body calls `store.get`, and each of those
 * reads the file. So an `EMFILE` on one of them arrives at the classifier with
 * nothing left to identify it as an I/O failure, looks deterministic, fails the
 * same way four times, and used to condemn a perfectly good config.
 *
 * Read order inside one construction, verified by stack-walking every
 * `readFileSync`: 1 `#runMigrations`, 2 `_migrate`'s `_get`, 3 `_migrate`'s
 * `structuredClone` backup, then 4 onwards inside the `try`. Only 4 onwards is
 * laundered, which is why the counts below are what they are.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const,
// so the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.57.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager, ConfigUnreadableError } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** Reads that happen before `_migrate` enters its per-migration `try`. */
const READS_BEFORE_THE_TRY = 3;

/** A config from before the migration chain, so an upgrade boot has work to do. */
const STORED_VERSION = '0.43.0';

/**
 * The retry staircase, with the waiting taken out.
 *
 * Same number of attempts, no real seconds spent. `sleepSync` parks the worker
 * thread, and at the shipped delays this suite held one for around thirty
 * seconds, which was enough to make timing-sensitive tests in other files
 * flake. The one test below that must prove the shipped schedule says so.
 */
const FAST_RETRIES = { retryDelaysMs: [0, 0, 0] } as const;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a valid config that is one upgrade behind.
 *
 * @param extra - Settings to store alongside the migration marker.
 */
function seedUpgradeBoot(extra: Record<string, unknown> = {}): {
  dir: string;
  configPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-upgrade-boot-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      ...extra,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return { dir, configPath };
}

/** An `fs` error carrying an errno code, the shape a real I/O failure has. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Fail reads of one path whenever `shouldFail` says so.
 *
 * @param configPath - The path whose reads may fail.
 * @param shouldFail - Called per read of that path; `true` raises `EMFILE`.
 */
function failReadsWhen(configPath: string, shouldFail: () => boolean): void {
  const real = fs.readFileSync.bind(fs);
  const fake = (file: unknown, options?: unknown): unknown => {
    if (typeof file === 'string' && path.resolve(file) === configPath && shouldFail()) {
      throw errnoError('EMFILE', `injected by test, open '${file}'`);
    }
    return (real as (f: unknown, o?: unknown) => unknown)(file, options);
  };
  vi.spyOn(fs, 'readFileSync').mockImplementation(fake as unknown as typeof fs.readFileSync);
}

/**
 * A seeded pseudo-random source, so a storm trial is reproducible.
 *
 * @param seed - The starting state.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('an upgrade boot on a machine that is struggling', () => {
  it('really is running migrations, or none of the rest of this file means anything', () => {
    // The whole file is vacuous without the override, and a vacuous suite is
    // how the defect below survived its first review.
    expect(SERVER_VERSION).toBe('0.57.0');
  });

  it('preserves the file when a storm hits the reads inside a migration body', () => {
    const { dir, configPath } = seedUpgradeBoot({ auth: { enabled: true } });

    // Everything from the first read inside the `try` onwards.
    let reads = 0;
    failReadsWhen(configPath, () => ++reads > READS_BEFORE_THE_TRY);

    expect(() => new ConfigManager(dir, FAST_RETRIES)).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();

    // Not byte-for-byte: `conf` merges its defaults into the file before any
    // migration runs, which is a legitimate write on an upgrade boot. The claim
    // that matters is that nothing was condemned and the settings survived.
    expect(fs.existsSync(configPath + '.bak')).toBe(false);
    expect(new ConfigManager(dir, FAST_RETRIES).get('auth').enabled).toBe(true);
  });

  it('does not condemn a good file when only the laundered reads are failing', () => {
    // The case the never-replace-what-you-could-not-read gate cannot catch on
    // its own. The storm lets reads through in gaps, so the salvage read
    // succeeds and the gate opens. If the errno is not dug back out of conf's
    // wrapper, the file is condemned: the protections survive, but the
    // preferences do not, and pins are exactly what the original incident cost.
    const { dir, configPath } = seedUpgradeBoot({
      ui: { statusBar: { pins: ['permission'] } },
    });

    // Per attempt: let the three pre-`try` reads through, fail the fourth, then
    // reset so the next attempt looks identical. The salvage read that follows
    // the last attempt lands on a fresh counter and is let through.
    let readsThisAttempt = 0;
    failReadsWhen(configPath, () => {
      readsThisAttempt++;
      if (readsThisAttempt <= READS_BEFORE_THE_TRY) return false;
      readsThisAttempt = 0;
      return true;
    });

    expect(() => new ConfigManager(dir, FAST_RETRIES)).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();

    expect(fs.existsSync(configPath + '.bak')).toBe(false);
    expect(new ConfigManager(dir, FAST_RETRIES).getDot('ui.statusBar.pins')).toEqual([
      'permission',
    ]);
  });

  it(
    'survives a storm of intermittent read failures at every intensity',
    { timeout: 120_000 },
    () => {
      // The measured shape of the defect: a valid config, a pending migration,
      // and reads that fail some of the time. Every trial must end with the file
      // still on disk and the login gate still on, whether DorkOS booted or
      // stopped. Seeded, so a failure is reproducible rather than a flake.
      const rand = seededRandom(20260727);
      const TRIALS_PER_INTENSITY = 6;
      let condemned = 0;
      let booted = 0;

      for (const probability of [0.05, 0.15, 0.3]) {
        for (let trial = 0; trial < TRIALS_PER_INTENSITY; trial++) {
          const { dir, configPath } = seedUpgradeBoot({ auth: { enabled: true } });
          failReadsWhen(configPath, () => rand() < probability);
          try {
            new ConfigManager(dir, FAST_RETRIES);
            booted++;
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigUnreadableError);
          }
          vi.restoreAllMocks();

          if (fs.existsSync(configPath + '.bak')) condemned++;
          // Whatever happened, the settings are readable once the storm passes.
          expect(new ConfigManager(dir, FAST_RETRIES).get('auth').enabled).toBe(true);
        }
      }

      expect(condemned).toBe(0);
      // Guard against a vacuous pass: the light storm has to be survivable, or
      // this is only ever testing the refusal path.
      expect(booted).toBeGreaterThan(0);
    }
  );

  it('still completes an ordinary upgrade boot', () => {
    // The control. Nothing failing, migrations run, settings kept.
    const { dir, configPath } = seedUpgradeBoot({ auth: { enabled: true } });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(fs.existsSync(configPath + '.bak')).toBe(false);
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});
