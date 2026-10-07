/**
 * Removing `rooms.maxPostsPerTurn` and `rooms.maxCanvasOpsPerTurn` across the
 * real `conf`/Ajv seam (DOR-2739; ADR 261006-225605 retires agent-only caps).
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
const STORED_VERSION = '0.101.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a config one release behind this key.
 *
 * @param rooms - The `rooms` block to write to disk.
 */
function seedUpgradeBoot(rooms: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-agent-caps-migration-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      rooms,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** What is actually on disk after the manager has booted. */
function readRooms(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).rooms;
}

describe('dropping the per-turn agent caps on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.102.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.102.0');
  });

  it('removes both caps and keeps everything else under rooms', () => {
    const dir = seedUpgradeBoot({ maxAgentDepth: 12, maxPostsPerTurn: 1, maxCanvasOpsPerTurn: 2 });

    const manager = new ConfigManager(dir);

    const rooms = readRooms(dir);
    expect(rooms).not.toHaveProperty('maxPostsPerTurn');
    expect(rooms).not.toHaveProperty('maxCanvasOpsPerTurn');
    expect(rooms.maxAgentDepth).toBe(12);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('is a no-op for a config that never had them, and idempotent on a second boot', () => {
    const dir = seedUpgradeBoot({ maxAgentDepth: 9 });
    new ConfigManager(dir);
    const second = new ConfigManager(dir);

    expect(readRooms(dir)).not.toHaveProperty('maxPostsPerTurn');
    expect(readRooms(dir).maxAgentDepth).toBe(9);
    expect(second.validate()).toEqual({ valid: true });
  });
});
