/**
 * Removing `scheduler.timezone` across the real `conf`/Ajv seam (DOR-1482).
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.68.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported,
 * which means before this file's imports, which means a separate module registry
 * — the same reasoning `config-room-turn-limits-migration.test.ts` gives next
 * door.
 *
 * ## Why a real manager rather than a mock store
 *
 * The whole question here is whether a key gets DELETED from a file that
 * already holds it, and whether the file still validates afterwards. Zod strips
 * an unknown key where Ajv rejects it, so a schema-level assertion would answer
 * a different question than the one that matters. Only a real file answers this
 * one, and the assertions read the file rather than the manager: `conf`'s store
 * getter re-reads and re-validates on every access, so a value it filled into
 * the copy it is about to hand back would make a manager-level assertion pass
 * with the migration body deleted (DOR-1496).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.68.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from the release before this key. */
const STORED_VERSION = '0.67.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a valid config one release behind this key,
 * with the scheduler block as an upgrading install carries it.
 *
 * @param scheduler - The `scheduler` block to write to disk.
 */
function seedUpgradeBoot(scheduler: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-scheduler-tz-migration-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      scheduler,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** What is actually on disk after the manager has booted. */
function readConfig(dir: string): Record<string, never> & { scheduler: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
}

describe('dropping scheduler.timezone on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.68.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.68.0');
  });

  it('removes the setting from a config that carries it', () => {
    // It never did anything: every schedule stores its own timezone, so the
    // scheduler's fallback to this value could not be reached. A control that
    // does nothing does not stay in Settings looking functional.
    const dir = seedUpgradeBoot({
      enabled: true,
      maxConcurrentRuns: 4,
      timezone: 'America/New_York',
      retentionCount: 100,
    });

    const manager = new ConfigManager(dir);

    expect(readConfig(dir).scheduler).not.toHaveProperty('timezone');
    // The rest of the section is untouched, and the file still validates.
    expect(manager.get('scheduler').maxConcurrentRuns).toBe(4);
    expect(manager.get('scheduler').retentionCount).toBe(100);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('is a no-op for a config that never had it', () => {
    const dir = seedUpgradeBoot({ enabled: true, maxConcurrentRuns: 4, retentionCount: 100 });

    const manager = new ConfigManager(dir);

    expect(readConfig(dir).scheduler).not.toHaveProperty('timezone');
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('is idempotent, so a second boot reads the migrated file cleanly', () => {
    const dir = seedUpgradeBoot({
      enabled: true,
      maxConcurrentRuns: 4,
      timezone: 'UTC',
      retentionCount: 100,
    });
    new ConfigManager(dir);

    const second = new ConfigManager(dir);

    expect(readConfig(dir).scheduler).not.toHaveProperty('timezone');
    expect(second.validate()).toEqual({ valid: true });
  });
});
