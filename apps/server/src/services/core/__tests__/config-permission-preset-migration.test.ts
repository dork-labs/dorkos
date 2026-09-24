/**
 * The `0.83.0` migration (spec `agent-permissions` D13, phase 1) across the real
 * `conf`/Ajv seam: the first-run power choice becomes the permission preset.
 *
 * A file of its own for the reason `config-full-power-defaults-migration.test.ts`
 * gives: `conf` runs a key only when it is `<= projectVersion`, and the version
 * override has to be in the environment before `lib/version.ts` loads. The first
 * case asserts the override took, so the rest cannot pass having run nothing.
 *
 * Every assertion reads `config.json` from DISK (DOR-1496): conf's read path
 * fills defaults into a throwaway copy, so an in-memory read would pass with the
 * body suppressed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.83.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config written by the release immediately before this key. */
const STORED_VERSION = '0.82.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temp data directory holding a config one release behind, with a door answer. */
function seedUpgradeBoot(fullPowerChoice: 'full' | 'supervised' | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-permission-preset-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ui: {
        theme: 'system',
        fullPowerDecidedAt: fullPowerChoice ? '2026-09-01T09:00:00.000Z' : null,
        fullPowerChoice,
      },
      runtimes: { default: 'claude-code', defaultTrustStop: 'act' },
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** The stored file, as the next boot will read it. */
function readDisk(dir: string): {
  permissions?: { preset: unknown; defaults: unknown; upgradeSweptVersion: unknown };
  runtimes: { defaultTrustStop: unknown };
} {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

describe('the 0.83.0 migration on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.83.0 migration', () => {
    expect(SERVER_VERSION).toBe('0.83.0');
  });

  it("maps a door answered 'full' to the Full power preset", () => {
    const dir = seedUpgradeBoot('full');
    new ConfigManager(dir);
    expect(readDisk(dir).permissions?.preset).toBe('full');
  });

  it("maps a door answered 'supervised' to the Careful preset", () => {
    const dir = seedUpgradeBoot('supervised');
    new ConfigManager(dir);
    expect(readDisk(dir).permissions?.preset).toBe('careful');
  });

  it('leaves an unanswered door on no preset (Unchanged)', () => {
    const dir = seedUpgradeBoot(null);
    const manager = new ConfigManager(dir);
    expect(readDisk(dir).permissions?.preset ?? null).toBeNull();
    expect(manager.getDot('permissions.preset')).toBeNull();
  });

  it('never touches the trust stop, whichever way the door went', () => {
    for (const choice of ['full', 'supervised', null] as const) {
      const dir = seedUpgradeBoot(choice);
      new ConfigManager(dir);
      expect(readDisk(dir).runtimes.defaultTrustStop).toBe('act');
    }
  });

  it('keeps the rest of the section at its defaults', () => {
    const dir = seedUpgradeBoot('full');
    new ConfigManager(dir);
    expect(readDisk(dir).permissions).toEqual({
      preset: 'full',
      defaults: { areas: {}, actions: {} },
      upgradeSweptVersion: null,
    });
  });
});
