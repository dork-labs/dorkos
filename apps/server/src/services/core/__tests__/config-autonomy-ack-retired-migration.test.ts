/**
 * Removing `ui.autonomyAcknowledgedAt` across the real `conf`/Ajv seam
 * (DOR-2739; ADR 261006-225605 retires the Full-autonomy acknowledgement).
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.102.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported —
 * the same reasoning `config-scheduler-timezone-migration.test.ts` gives.
 *
 * ## Why the assertions read the file
 *
 * `conf`'s store getter re-reads and re-validates on every access, so a manager
 * assertion can pass with the migration body deleted (DOR-1496). Only the file
 * on disk answers whether the key was removed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.102.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from the release before this key. */
const STORED_VERSION = '0.100.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a config one release behind this key.
 *
 * @param ui - The `ui` block to write to disk.
 */
function seedUpgradeBoot(ui: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-autonomy-ack-migration-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ui,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** What is actually on disk after the manager has booted. */
function readUi(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).ui;
}

describe('dropping ui.autonomyAcknowledgedAt on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.102.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.102.0');
  });

  it('removes a recorded acknowledgement and keeps everything else under ui', () => {
    const dir = seedUpgradeBoot({
      theme: 'dark',
      autonomyAcknowledgedAt: '2026-09-01T10:00:00.000Z',
      fullPowerChoice: 'full',
    });

    const manager = new ConfigManager(dir);

    const ui = readUi(dir);
    expect(ui).not.toHaveProperty('autonomyAcknowledgedAt');
    expect(ui.theme).toBe('dark');
    expect(ui.fullPowerChoice).toBe('full');
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('removes a null one the same way', () => {
    const dir = seedUpgradeBoot({ autonomyAcknowledgedAt: null });

    new ConfigManager(dir);

    expect(readUi(dir)).not.toHaveProperty('autonomyAcknowledgedAt');
  });

  it('is a no-op for a config that never had it, and idempotent on a second boot', () => {
    const dir = seedUpgradeBoot({ theme: 'light' });
    new ConfigManager(dir);
    const second = new ConfigManager(dir);

    expect(readUi(dir)).not.toHaveProperty('autonomyAcknowledgedAt');
    expect(readUi(dir).theme).toBe('light');
    expect(second.validate()).toEqual({ valid: true });
  });
});
