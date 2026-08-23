/**
 * The raised room bounds (DOR-1428) across the real `conf`/Ajv seam.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.66.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported,
 * which means before this file's imports, which means a separate module registry
 * — the same reasoning `config-a2a-migration.test.ts` gives next door.
 *
 * ## Why a real manager rather than a mock store
 *
 * `.claude/rules/safe-defaults.md`: mock stores never cross the `conf`/Ajv seam,
 * and `UserConfigSchema.parse` cannot substitute — Zod strips unknown keys where
 * Ajv rejects them. This migration WRITES BACK values a person may have chosen
 * and adds two leaves to a section already on disk, so the questions worth
 * asking are whether the write validates and whether the person's own numbers
 * came out the other side. Only a real file answers either.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.66.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from the release before this key. */
const STORED_VERSION = '0.65.0';

/** The `rooms` block an install seeded by every earlier key is carrying. */
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
 * A temp data directory holding a valid config one release behind this key.
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
  it('really is running the 0.66.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.66.0');
  });

  it('raises every bound the person never touched', () => {
    const manager = new ConfigManager(seedUpgradeBoot(STOCK_ROOMS));

    const rooms = manager.get('rooms');
    expect(rooms.maxAgentDepth).toBe(30);
    expect(rooms.maxAutomaticTurnsPerRoomPerHour).toBe(1000);
    expect(rooms.maxAutomaticTurnsTotalPerHour).toBe(5000);
    // The rest of the section is left exactly as it stood.
    expect(rooms.replyWaitMinutes).toBe(10);
    expect(rooms.collectMaxEntries).toBe(20);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('adds the two leaves conf would never have merged into an existing section', () => {
    // The shallow-merge trap every `rooms` backfill in this table exists for: a
    // section already on disk inherits no new nested field on its own.
    const manager = new ConfigManager(seedUpgradeBoot(STOCK_ROOMS));

    expect(manager.get('rooms').turnLimitsEnabled).toBe(true);
    expect(manager.get('rooms').maxTurnsPerAgentPerCascade).toBe(10);
  });

  it('leaves a number the person chose exactly where they put it', () => {
    // The whole of safe-defaults rule 3. A tightened bound is a decision, and
    // this migration spends money when it moves one — so it moves only the
    // values that still equal what they were seeded with.
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
    // The one they DID leave alone still moves: the rule is per value, never
    // "this person has opinions, leave the section".
    expect(rooms.maxAutomaticTurnsPerRoomPerHour).toBe(1000);
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

    expect(second.get('rooms').maxAgentDepth).toBe(30);
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
