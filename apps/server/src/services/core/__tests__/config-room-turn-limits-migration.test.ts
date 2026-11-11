/** Room limits stay as chosen across supported upgrades and real writes. */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';

/** The oldest supported upgrade version. */
const STORED_VERSION = '0.115.0';

/** Stored room limits, including deliberate choices equal to older defaults. */
const STOCK_ROOMS = {
  maxAgentDepth: 3,
  maxAutomaticTurnsPerRoomPerHour: 60,
  maxAutomaticTurnsTotalPerHour: 240,
  replyWaitMinutes: 10,
  lateReplyCeilingMinutes: 60,
  engagedWindowMinutes: 10,
  engagedWindowPosts: 5,
  collectDebounceMs: 500,
  collectMaxEntries: 20,
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temporary directory holding a config at the supported upgrade floor.
 *
 * @param rooms - The `rooms` block to write, as this install has it on disk.
 */
function seedUpgradeBoot(rooms: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-limits-migration-'));
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

describe('the raised room bounds on an upgrade boot (real conf + Ajv)', () => {
  it('leaves a number the person chose exactly where they put it', () => {
    // A tightened bound is a decision; a supported upgrade keeps it.
    const manager = new ConfigManager(
      seedUpgradeBoot({
        ...STOCK_ROOMS,
        maxAgentDepth: 1,
        maxAutomaticTurnsTotalPerHour: 100,
      })
    );

    const rooms = manager.get('rooms');
    expect(rooms.maxAgentDepth).toBe(1);
    expect(rooms.maxAutomaticTurnsTotalPerHour).toBe(100);
    // Even a stored value equal to a former default stays as chosen.
    expect(rooms.maxAutomaticTurnsPerRoomPerHour).toBe(60);
  });

  it('never turns limits off for somebody, and never turns them back on', () => {
    // The new switch is seeded ON where it is absent, and an install that
    // already carries it — from a build made during this window — keeps what it
    // says, in both directions.
    expect(
      new ConfigManager(seedUpgradeBoot({ ...STOCK_ROOMS, turnLimitsEnabled: false })).get('rooms')
        .turnLimitsEnabled
    ).toBe(false);
    expect(
      new ConfigManager(seedUpgradeBoot({ ...STOCK_ROOMS, turnLimitsEnabled: true })).get('rooms')
        .turnLimitsEnabled
    ).toBe(true);
  });

  it('is idempotent, so a second boot reads the migrated file cleanly', () => {
    const dir = seedUpgradeBoot(STOCK_ROOMS);
    new ConfigManager(dir);

    const second = new ConfigManager(dir);

    expect(second.get('rooms').maxAgentDepth).toBe(3);
    expect(second.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
  });

  it('a fresh install gets the raised numbers from the schema alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-limits-fresh-'));
    dirs.push(dir);

    const rooms = new ConfigManager(dir).get('rooms');

    expect(rooms.turnLimitsEnabled).toBe(true);
    expect(rooms.maxAgentDepth).toBe(30);
    expect(rooms.maxTurnsPerAgentPerCascade).toBe(10);
    expect(rooms.maxAutomaticTurnsPerRoomPerHour).toBe(1000);
    expect(rooms.maxAutomaticTurnsTotalPerHour).toBe(5000);
  });

  it('accepts limits turned off and hands that back through a real load', () => {
    // The write path Settings will take through `PATCH /api/config`: Ajv must
    // ADMIT the new leaves, not merely tolerate their defaults. A schema that
    // typed either wrong would condemn the whole file here.
    const dir = seedUpgradeBoot(STOCK_ROOMS);
    const manager = new ConfigManager(dir);

    manager.set('rooms', {
      ...manager.get('rooms'),
      turnLimitsEnabled: false,
      maxTurnsPerAgentPerCascade: 100,
    });

    const reloaded = new ConfigManager(dir).get('rooms');
    expect(reloaded.turnLimitsEnabled).toBe(false);
    expect(reloaded.maxTurnsPerAgentPerCascade).toBe(100);
    expect(manager.validate()).toEqual({ valid: true });
  });
});
