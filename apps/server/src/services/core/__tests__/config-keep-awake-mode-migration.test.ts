/**
 * Turning `keepAwake.whileAgentsWork` into `keepAwake.mode` across the real
 * `conf`/Ajv seam (DOR-2920).
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.116.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported —
 * the same reasoning `config-scheduler-timezone-migration.test.ts` gives.
 *
 * ## Why the assertions read the file
 *
 * `conf`'s store getter re-reads and re-validates on every access, and Ajv's
 * `useDefaults` fills `mode: 'agents'` into the copy it hands back, so a
 * manager assertion can pass with the migration body deleted (DOR-1496). Only
 * the file on disk answers whether the leaf was moved, and `off` is the value
 * no default could ever produce.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.116.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from the release before this key. */
const STORED_VERSION = '0.114.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a config one release behind this key.
 *
 * @param keepAwake - The `keepAwake` block to write to disk.
 */
function seedUpgradeBoot(keepAwake: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-keep-awake-migration-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      keepAwake,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** What is actually on disk after the manager has booted. */
function readKeepAwake(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).keepAwake;
}

const NEW_LEAVES = {
  manualUntil: null,
  keepDisplayAwake: false,
  stopBelowBatteryPercent: null,
  onlyOnPower: false,
  closedLid: false,
};

describe('keepAwake.whileAgentsWork becomes keepAwake.mode on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.116.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.116.0');
  });

  it('turns a switched-off setting into mode off, deletes the old leaf, and writes the new ones', () => {
    const dir = seedUpgradeBoot({ whileAgentsWork: false, wakeForScheduledTasks: false });

    const manager = new ConfigManager(dir);

    expect(readKeepAwake(dir)).toEqual({
      mode: 'off',
      ...NEW_LEAVES,
      wakeForScheduledTasks: false,
    });
    expect(manager.get('keepAwake').mode).toBe('off');
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('turns a switched-on setting into mode agents', () => {
    const dir = seedUpgradeBoot({ whileAgentsWork: true, wakeForScheduledTasks: true });
    new ConfigManager(dir);
    expect(readKeepAwake(dir)).toEqual({
      mode: 'agents',
      ...NEW_LEAVES,
      wakeForScheduledTasks: true,
    });
  });

  it('reads a section with no switch at all as mode agents', () => {
    const dir = seedUpgradeBoot({ wakeForScheduledTasks: false });
    new ConfigManager(dir);
    expect(readKeepAwake(dir)).toMatchObject({ mode: 'agents', ...NEW_LEAVES });
    expect(readKeepAwake(dir)).not.toHaveProperty('whileAgentsWork');
  });

  it('is idempotent: a second boot keeps the mode, and a stored mode with no old leaf stays', () => {
    const dir = seedUpgradeBoot({ whileAgentsWork: false, wakeForScheduledTasks: false });
    new ConfigManager(dir);
    const second = new ConfigManager(dir);
    expect(readKeepAwake(dir).mode).toBe('off');
    expect(second.validate()).toEqual({ valid: true });

    const already = seedUpgradeBoot({
      mode: 'always',
      ...NEW_LEAVES,
      wakeForScheduledTasks: false,
    });
    new ConfigManager(already);
    expect(readKeepAwake(already).mode).toBe('always');
  });
});
